import argparse
from wsgiref.simple_server import make_server

from .app import create_app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--session-token", required=True)
    parser.add_argument("--e2e-runtime", default="")
    parser.add_argument("--command-endpoint", default="http://127.0.0.1:9529")
    args = parser.parse_args()
    if args.host not in ("127.0.0.1", "::1"):
        parser.error("local recognition agent only supports loopback")
    with make_server(args.host, args.port, create_app(args.session_token, args.e2e_runtime or None, args.command_endpoint)) as server:
        print(server.server_port)
        server.serve_forever()


if __name__ == "__main__":
    main()
