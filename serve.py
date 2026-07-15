"""Local web server for StepRayOptics with caching disabled,
so browser refreshes always pick up the latest code."""
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8341
    http.server.ThreadingHTTPServer(('', port), NoCacheHandler).serve_forever()
