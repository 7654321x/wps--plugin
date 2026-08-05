import argparse
from wsgiref.simple_server import make_server

from .app import create_app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--session-token", required=True)
    parser.add_argument("--e2e-runtime", default="")
    parser.add_argument(
        "--diagnostic-log-file",
        default="",
        help="UTF-8 JSONL diagnostic log file.",
    )
    args = parser.parse_args()
    if args.host not in ("127.0.0.1", "::1"):
        parser.error("local recognition agent only supports loopback")
    application = create_app(
        session_token=args.session_token,
        e2e_runtime=args.e2e_runtime or None,
        diagnostic_log_file=args.diagnostic_log_file or None,
    )
    with make_server(args.host, args.port, application) as server:
        print(server.server_port)
        server.serve_forever()


if __name__ == "__main__":
    main()
