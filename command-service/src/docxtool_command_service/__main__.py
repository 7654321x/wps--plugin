"""Run the command service in local or cloud-compatible mode."""

import argparse
from wsgiref.simple_server import make_server

from .api.app import create_app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("local", "cloud"), default="local")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--session-token", default="")
    args = parser.parse_args()
    if args.mode == "local" and args.host not in ("127.0.0.1", "::1"):
        parser.error("local mode only listens on a loopback address")
    app = create_app(mode=args.mode, session_token=args.session_token)
    with make_server(args.host, args.port, app) as server:
        print(server.server_port)
        server.serve_forever()


if __name__ == "__main__":
    main()
