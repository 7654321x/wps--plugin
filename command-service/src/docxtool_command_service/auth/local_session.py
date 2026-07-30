from .interface import Authenticator


class LocalSessionAuthenticator(Authenticator):
    def __init__(self, session_token):
        self._token = session_token

    def authorize(self, headers):
        return bool(self._token) and headers.get("X-Docxtool-Session") == self._token
