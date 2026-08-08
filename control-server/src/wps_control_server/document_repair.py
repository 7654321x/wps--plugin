"""Targeted DOCX relationship repair for the local WPS control plane."""

from __future__ import annotations

import hashlib
import os
import posixpath
import shutil
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional, Set, Tuple
from xml.etree import ElementTree as ET


PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
IMAGE_REL_TYPE = OFFICE_REL_NS + "/image"
DOCUMENT_RELS = "word/_rels/document.xml.rels"
DOCUMENT_XML = "word/document.xml"


class DocumentRepairError(RuntimeError):
    def __init__(self, code: str, stage: str = "document_repair", reason: str = "document_repair_failed", *, cause: Optional[BaseException] = None, **details: object) -> None:
        self.code = code
        self.details: Dict[str, object] = {"stage": stage, "reason": reason, **details}
        if cause is not None:
            self.details["exception_type"] = type(cause).__name__
        super().__init__(code)


def _failed(stage: str, reason: str, *, cause: Optional[BaseException] = None, **details: object) -> DocumentRepairError:
    return DocumentRepairError("DOCUMENT_REPAIR_FAILED", stage, reason, cause=cause, **details)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _normalized_target(target: str) -> str:
    return posixpath.normpath(target.replace("\\", "/"))


def _null_relationship_ids(data: bytes) -> Set[str]:
    root = ET.fromstring(data)
    result: Set[str] = set()
    for relationship in root:
        target = _normalized_target(relationship.get("Target") or "")
        if target != "../NULL":
            continue
        if relationship.get("Type") != IMAGE_REL_TYPE or not relationship.get("Id"):
            raise _failed("inspect.relationships", "null_relationship_is_not_a_named_image")
        result.add(str(relationship.get("Id")))
    return result


def _relationship_ids(data: bytes) -> Set[str]:
    root = ET.fromstring(data)
    return {str(item.get("Id")) for item in root if item.get("Id")}


def _dangling_blip_relationship_ids(document_data: bytes, valid_relationship_ids: Set[str]) -> Set[str]:
    root = ET.fromstring(document_data)
    dangling: Set[str] = set()
    for blip in root.iter("{%s}blip" % DRAWING_NS):
        relationship_id = blip.get("{%s}embed" % OFFICE_REL_NS)
        if relationship_id and relationship_id not in valid_relationship_ids:
            dangling.add(relationship_id)
    return dangling


def _remove_null_relationships(data: bytes, expected_ids: Set[str]) -> bytes:
    root = ET.fromstring(data)
    removed: Set[str] = set()
    for relationship in list(root):
        target = _normalized_target(relationship.get("Target") or "")
        if target == "../NULL":
            removed.add(str(relationship.get("Id") or ""))
            root.remove(relationship)
    if removed != expected_ids:
        raise _failed("apply.relationships", "removed_relationship_set_mismatch", expected_count=len(expected_ids), actual_count=len(removed))
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _remove_broken_drawings(data: bytes, relationship_ids: Set[str]) -> Tuple[bytes, int]:
    root = ET.fromstring(data)
    parent = {child: owner for owner in root.iter() for child in owner}
    drawings = []
    for blip in root.iter("{%s}blip" % DRAWING_NS):
        if blip.get("{%s}embed" % OFFICE_REL_NS) not in relationship_ids:
            continue
        current = blip
        while current in parent and current.tag != "{%s}drawing" % WORD_NS:
            current = parent[current]
        if current.tag != "{%s}drawing" % WORD_NS:
            raise _failed("apply.drawings", "broken_image_reference_has_no_drawing")
        drawings.append(current)
    if len(drawings) != len(relationship_ids):
        raise _failed("apply.drawings", "drawing_count_mismatch", expected_count=len(relationship_ids), actual_count=len(drawings))
    removed = 0
    for drawing in dict.fromkeys(drawings):
        drawing_parent = parent.get(drawing)
        if drawing_parent is None:
            raise _failed("apply.drawings", "drawing_parent_missing")
        run = drawing_parent if drawing_parent.tag == "{%s}r" % WORD_NS else None
        drawing_parent.remove(drawing)
        removed += 1
        if run is not None:
            run_parent = parent.get(run)
            substantive = [child for child in run if child.tag != "{%s}rPr" % WORD_NS]
            if not substantive and run_parent is not None:
                run_parent.remove(run)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True), removed


def _source_part(rels_name: str) -> str:
    if rels_name == "_rels/.rels":
        return ""
    marker = "/_rels/"
    if marker not in rels_name or not rels_name.endswith(".rels"):
        raise _failed("validate.relationships", "relationship_part_name_invalid", member=rels_name)
    prefix, leaf = rels_name.split(marker, 1)
    return posixpath.join(prefix, leaf[:-5])


def _rels_part(source_part: str) -> str:
    if not source_part:
        return "_rels/.rels"
    directory, leaf = posixpath.split(source_part)
    return posixpath.join(directory, "_rels", leaf + ".rels")


def _target_part(source_part: str, target: str) -> str:
    value = target.replace("\\", "/")
    if value.startswith("/"):
        value = value[1:]
    else:
        value = posixpath.join(posixpath.dirname(source_part), value)
    normalized = posixpath.normpath(value)
    if normalized == ".." or normalized.startswith("../"):
        raise _failed("validate.relationships", "relationship_target_escapes_package", member=source_part)
    return normalized


def _validate_package(path: Path, expected_members: Set[str], expected_member_sha256: Dict[str, str]) -> None:
    with zipfile.ZipFile(path, "r") as archive:
        bad_member = archive.testzip()
        if bad_member is not None:
            raise _failed("validate.zip_crc", "zip_crc_failed", member=bad_member)
        members = set(archive.namelist())
        if members != expected_members:
            raise _failed("validate.members", "package_member_set_changed", expected_count=len(expected_members), actual_count=len(members))
        for name in members - {DOCUMENT_RELS, DOCUMENT_XML}:
            if hashlib.sha256(archive.read(name)).hexdigest() != expected_member_sha256[name]:
                raise _failed("validate.members", "unrelated_package_member_changed", member=name)
        roots: Dict[str, ET.Element] = {}
        for name in members:
            if name.endswith(".xml") or name.endswith(".rels"):
                roots[name] = ET.fromstring(archive.read(name))
        relationship_ids: Dict[str, Set[str]] = {}
        for rels_name, root in roots.items():
            if not rels_name.endswith(".rels"):
                continue
            source = _source_part(rels_name)
            ids: Set[str] = set()
            for relationship in root:
                rel_id = relationship.get("Id") or ""
                target = relationship.get("Target") or ""
                if not rel_id or not target or rel_id in ids:
                    raise _failed("validate.relationships", "relationship_id_or_target_invalid", member=rels_name)
                ids.add(rel_id)
                if relationship.get("TargetMode") != "External":
                    target_part = _target_part(source, target)
                    if target_part not in members:
                        raise _failed("validate.relationships", "relationship_target_missing", member=rels_name, target_member=target_part)
            relationship_ids[source] = ids
        for part_name, root in roots.items():
            if part_name.endswith(".rels"):
                continue
            referenced = {
                value
                for element in root.iter()
                for key, value in element.attrib.items()
                if key.startswith("{%s}" % OFFICE_REL_NS)
            }
            if not referenced:
                continue
            if not referenced.issubset(relationship_ids.get(part_name, set())):
                raise _failed("validate.references", "xml_contains_dangling_relationship_reference", member=part_name)
        if _null_relationship_ids(archive.read(DOCUMENT_RELS)):
            raise _failed("validate.relationships", "null_relationship_remains", member=DOCUMENT_RELS)


@dataclass
class RepairRecord:
    repair_id: str
    source_path: Path
    source_sha256: str
    relationship_ids: Set[str]
    drawing_relationship_ids: Set[str]
    member_names: Set[str]
    member_sha256: Dict[str, str]
    backup_path: Optional[Path] = None
    apply_attempted: bool = False
    applied: bool = False


class DocumentRepairManager:
    def __init__(self) -> None:
        self._records: Dict[str, RepairRecord] = {}

    def inspect(self, source_path: str) -> Dict[str, object]:
        try:
            source = Path(source_path).expanduser().resolve(strict=True)
        except OSError as error:
            raise _failed("inspect.source", "source_path_not_accessible", cause=error) from error
        if source.suffix.casefold() != ".docx" or not source.is_file():
            raise _failed("inspect.source", "source_is_not_a_local_docx")
        try:
            with zipfile.ZipFile(source, "r") as archive:
                bad_member = archive.testzip()
                if bad_member is not None:
                    raise _failed("inspect.zip_crc", "zip_crc_failed", member=bad_member)
                try:
                    relationship_bytes = archive.read(DOCUMENT_RELS)
                except KeyError as error:
                    raise _failed("inspect.relationships", "document_relationship_part_missing", cause=error, member=DOCUMENT_RELS) from error
                try:
                    document_bytes = archive.read(DOCUMENT_XML)
                except KeyError as error:
                    raise _failed("inspect.document", "document_xml_part_missing", cause=error, member=DOCUMENT_XML) from error
                relationship_ids = _null_relationship_ids(relationship_bytes)
                all_relationship_ids = _relationship_ids(relationship_bytes)
                dangling_drawing_ids = _dangling_blip_relationship_ids(document_bytes, all_relationship_ids)
                drawing_relationship_ids = relationship_ids | dangling_drawing_ids
                members = set(archive.namelist())
                member_sha256 = {name: hashlib.sha256(archive.read(name)).hexdigest() for name in members}
        except DocumentRepairError:
            raise
        except (KeyError, OSError, zipfile.BadZipFile, ET.ParseError) as error:
            raise _failed("inspect.package", "docx_package_could_not_be_read", cause=error) from error
        inspection_metrics = {
            "package_member_count": len(members),
            "document_relationship_count": len(all_relationship_ids),
            "null_relationship_count": len(relationship_ids),
            "dangling_drawing_count": len(dangling_drawing_ids),
        }
        if not drawing_relationship_ids:
            try:
                _validate_package(source, members, member_sha256)
            except DocumentRepairError:
                raise
            except (KeyError, OSError, zipfile.BadZipFile, ET.ParseError) as error:
                raise _failed("inspect.validate", "docx_package_validation_failed", cause=error) from error
            return {"schema_version": 1, "status": "clean", **inspection_metrics}
        repair_id = str(uuid.uuid4())
        try:
            source_sha256 = _sha256(source)
        except OSError as error:
            raise _failed("inspect.hash", "source_sha256_failed", cause=error) from error
        self._records[repair_id] = RepairRecord(repair_id, source, source_sha256, relationship_ids, drawing_relationship_ids, members, member_sha256)
        return {"schema_version": 1, "status": "repair_required", "repair_id": repair_id, "broken_relationship_count": len(drawing_relationship_ids), **inspection_metrics}

    def apply(self, repair_id: str) -> Dict[str, object]:
        record = self._record(repair_id)
        if record.apply_attempted:
            raise _failed("apply.record", "repair_id_already_applied")
        record.apply_attempted = True
        try:
            current_sha256 = _sha256(record.source_path)
        except OSError as error:
            self._records.pop(repair_id, None)
            raise _failed("apply.source_hash", "source_sha256_failed", cause=error) from error
        if current_sha256 != record.source_sha256:
            self._records.pop(repair_id, None)
            raise DocumentRepairError("DOCUMENT_REPAIR_SOURCE_CHANGED", "apply.source_hash", "source_changed_after_inspection")
        suffix = repair_id.replace("-", "")[:12]
        backup = record.source_path.with_name(".%s.docxtool-repair-backup-%s.docx" % (record.source_path.stem, suffix))
        temporary = record.source_path.with_name(".%s.docxtool-repairing-%s.docx" % (record.source_path.stem, suffix))
        try:
            shutil.copy2(record.source_path, backup)
            removed_drawing_count = 0
            with zipfile.ZipFile(record.source_path, "r") as source_archive, zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as output_archive:
                output_archive.comment = source_archive.comment
                for item in source_archive.infolist():
                    data = source_archive.read(item)
                    if item.filename == DOCUMENT_RELS:
                        data = _remove_null_relationships(data, record.relationship_ids)
                    elif item.filename == DOCUMENT_XML:
                        data, removed = _remove_broken_drawings(data, record.drawing_relationship_ids)
                        if removed != len(record.drawing_relationship_ids):
                            raise _failed("apply.drawings", "removed_drawing_count_mismatch", expected_count=len(record.drawing_relationship_ids), actual_count=removed)
                        removed_drawing_count = removed
                    output_archive.writestr(item, data)
            _validate_package(temporary, record.member_names, record.member_sha256)
            os.replace(str(temporary), str(record.source_path))
            record.backup_path = backup
            record.applied = True
            return {"schema_version": 1, "status": "applied", "repair_id": repair_id, "removed_relationship_count": len(record.relationship_ids), "removed_drawing_count": removed_drawing_count}
        except DocumentRepairError:
            temporary.unlink(missing_ok=True)
            backup.unlink(missing_ok=True)
            self._records.pop(repair_id, None)
            raise
        except (OSError, zipfile.BadZipFile, ET.ParseError) as error:
            temporary.unlink(missing_ok=True)
            backup.unlink(missing_ok=True)
            self._records.pop(repair_id, None)
            raise _failed("apply.package", "repair_package_write_or_replace_failed", cause=error) from error

    def complete(self, repair_id: str, outcome: str) -> Dict[str, object]:
        record = self._record(repair_id)
        if not record.applied or record.backup_path is None:
            raise _failed("complete.record", "repair_was_not_applied")
        if outcome == "commit":
            try:
                record.backup_path.unlink(missing_ok=True)
            except OSError as error:
                raise _failed("complete.commit", "rollback_copy_delete_failed", cause=error) from error
            self._records.pop(repair_id, None)
            return {"schema_version": 1, "status": "committed", "repair_id": repair_id}
        if outcome == "restore":
            try:
                os.replace(str(record.backup_path), str(record.source_path))
            except OSError as error:
                raise DocumentRepairError("DOCUMENT_REPAIR_RECOVERY_REQUIRED", "complete.restore", "rollback_copy_restore_failed", cause=error) from error
            self._records.pop(repair_id, None)
            return {"schema_version": 1, "status": "restored", "repair_id": repair_id}
        raise _failed("complete.outcome", "repair_outcome_invalid")

    def _record(self, repair_id: str) -> RepairRecord:
        try:
            uuid.UUID(repair_id)
        except ValueError as error:
            raise _failed("repair.record", "repair_id_invalid", cause=error) from error
        record = self._records.get(repair_id)
        if record is None:
            raise _failed("repair.record", "repair_id_not_found")
        return record
