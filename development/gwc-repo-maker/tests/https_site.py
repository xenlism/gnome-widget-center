"""Serve a folder over HTTPS (test helper for tests/publish_ui.test.js):  python3 tests/https_site.py DIR PORT CERT KEY"""
import functools, ssl, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

d, port, cert, key = sys.argv[1:5]


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a, **k): pass


srv = ThreadingHTTPServer(("127.0.0.1", int(port)), functools.partial(Quiet, directory=d))
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cert, key)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
