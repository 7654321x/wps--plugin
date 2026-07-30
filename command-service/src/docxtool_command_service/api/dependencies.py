from ..auth.cloud_token import CloudTokenAuthenticator
from ..auth.local_session import LocalSessionAuthenticator


def build_authenticator(mode, session_token):
    if mode == "local":
        return LocalSessionAuthenticator(session_token)
    return CloudTokenAuthenticator(session_token)
