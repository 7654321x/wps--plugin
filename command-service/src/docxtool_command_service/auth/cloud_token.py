from .interface import Authenticator


class CloudTokenAuthenticator(Authenticator):
    def __init__(self, token):
        self._token = token

    def authorize(self, headers):
        return bool(self._token) and headers.get("Authorization") == "Bearer %s" % self._token
