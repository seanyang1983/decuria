import base64
import io
import unittest
import urllib.request
from unittest import mock

import security_utils


class _Response(io.BytesIO):
    def __init__(self, payload: bytes, length=None):
        super().__init__(payload)
        self.headers = {} if length is None else {"Content-Length": str(length)}


class SecurityUtilsTests(unittest.TestCase):
    def test_secret_preview_never_returns_short_secret(self):
        self.assertEqual(security_utils.secret_preview("short"), "••••")
        self.assertEqual(security_utils.secret_preview("abcdefghij"), "••••ij")
        self.assertNotIn("short", security_utils.secret_preview("short"))

    def test_private_url_requires_explicit_host_allowance(self):
        answer = [(2, 1, 6, "", ("127.0.0.1", 80))]
        with mock.patch("security_utils.socket.getaddrinfo", return_value=answer):
            with self.assertRaises(security_utils.UnsafeURLError):
                security_utils.validate_outbound_url("http://localhost/test")
            self.assertEqual(
                security_utils.validate_outbound_url(
                    "http://localhost/test", allow_private_hosts=("localhost",)
                ),
                "http://localhost/test",
            )

    def test_authenticated_cross_origin_redirect_is_rejected(self):
        handler = security_utils._ValidatingRedirectHandler(())
        request = urllib.request.Request(
            "https://api.example.test/start",
            headers={"Authorization": "Bearer placeholder"},
        )
        public = [(2, 1, 6, "", ("93.184.216.34", 443))]
        with mock.patch("security_utils.socket.getaddrinfo", return_value=public):
            with self.assertRaises(security_utils.UnsafeURLError):
                handler.redirect_request(
                    request, None, 302, "Found", {}, "https://other.example.test/next"
                )
    def test_bounded_reader_rejects_declared_and_streamed_overflow(self):
        with self.assertRaises(ValueError):
            security_utils.read_limited(_Response(b"x", length=9), 8)
        with self.assertRaises(ValueError):
            security_utils.read_limited(_Response(b"123456789"), 8)

    def test_raw_and_data_uri_base64_are_supported(self):
        encoded = base64.b64encode(b"image-bytes").decode("ascii")
        self.assertEqual(security_utils.decode_base64_payload(encoded, 32), b"image-bytes")
        self.assertEqual(
            security_utils.decode_base64_payload("data:image/png;base64," + encoded, 32),
            b"image-bytes",
        )
        with self.assertRaises(ValueError):
            security_utils.decode_base64_payload(encoded, 4)


if __name__ == "__main__":
    unittest.main()
