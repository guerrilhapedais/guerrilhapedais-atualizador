import argparse
import http.server
import mimetypes
import os
import socketserver


def main():
    p = argparse.ArgumentParser()
    p.add_argument("port", nargs="?", type=int, default=8765)
    args = p.parse_args()

    mimetypes.add_type("application/javascript", ".new")

    here = os.path.dirname(os.path.abspath(__file__))
    os.chdir(here)

    handler = http.server.SimpleHTTPRequestHandler
    with socketserver.TCPServer(("127.0.0.1", args.port), handler) as httpd:
        httpd.serve_forever()


if __name__ == "__main__":
    main()

