"""Regression checks for the byte-approved image/provenance exception."""
import hashlib
import importlib.util
from pathlib import Path
import struct
import unittest
import zlib

SPEC=importlib.util.spec_from_file_location('public_check',Path(__file__).with_name('verify-public.py'))
CHECK=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)

def chunk(kind,payload=b''):
    return struct.pack('>I',len(payload))+kind+payload+struct.pack('>I',zlib.crc32(kind+payload)&0xffffffff)

def fixture(extra=b'',width=1):
    return (b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,1,8,2,0,0,0))
            +extra+chunk(b'IDAT',zlib.compress(b'\x00\x00\x00\x00'))+chunk(b'IEND'))

def approved(data):
    return CHECK.approved_png(data,hashlib.sha256(data).hexdigest())

class ImagePrivacyTests(unittest.TestCase):
    def test_reviewed_valid_png_is_accepted(self):
        self.assertTrue(approved(fixture()))

    def test_changed_content_is_not_approved_by_old_hash(self):
        data=fixture()
        self.assertFalse(CHECK.approved_png(data,'0'*64))

    def test_text_and_exif_metadata_are_rejected_even_with_matching_hash(self):
        for kind in (b'tEXt',b'zTXt',b'iTXt',b'eXIf'):
            with self.subTest(kind=kind):
                self.assertFalse(approved(fixture(chunk(kind,b'private metadata'))))

    def test_trailing_content_is_rejected(self):
        self.assertFalse(approved(fixture()+b'unexpected trailing content'))

    def test_invalid_crc_is_rejected(self):
        data=bytearray(fixture())
        data[-1]^=1
        self.assertFalse(approved(bytes(data)))

    def test_invalid_dimensions_or_missing_end_are_rejected(self):
        self.assertFalse(approved(fixture(width=5000)))
        self.assertFalse(approved(fixture()[:-12]))

    def test_provenance_is_preserved_but_private_claim_text_is_rejected(self):
        self.assertTrue(approved(fixture(chunk(b'caBX',b'c2pa trainedAlgorithmicMedia'))))
        synthetic_key=('sk-'+'x'*30).encode()
        self.assertFalse(approved(fixture(chunk(b'caBX',synthetic_key))))

if __name__=='__main__':
    unittest.main()
