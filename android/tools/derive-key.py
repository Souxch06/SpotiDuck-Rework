#!/usr/bin/env python3
"""Derives the fallback release key used when no keystore secret is configured.

    python3 android/tools/derive-key.py build/release.p12

Why a *derived* key instead of a random one: Android only installs an update
over an existing app when both APKs are signed with the same key. The SDK debug
key is regenerated randomly on every CI machine, so every build would need an
uninstall first. This key is derived from a fixed seed, so it is byte-for-byte
identical on every run and sideloaded updates just work.

It is therefore **public**: anyone could sign a build with it. If that matters
to you, generate a private key with `make-keystore.py` and add it to the
repository secrets (SD_KEYSTORE_BASE64 & friends) — the workflow prefers the
secret when it exists. Do that before the first public APK if you want the
choice to be free; switching later means users must uninstall once.

Requires `cryptography` (pip install cryptography).
"""

import datetime
import hashlib
import os
import sys

try:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import NameOID
except ImportError:
    sys.exit("cryptography is missing — run: pip install cryptography")

SEED = b"SpotiDuck release signing key v1"
PASSWORD = "spotiduck"
ALIAS = b"spotiduck"


def derive_key():
    scalar = int.from_bytes(hashlib.sha256(SEED).digest(), "big")
    # Keep the scalar inside the P-256 group order.
    order = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
    return ec.derive_private_key(scalar % (order - 1) + 1, ec.SECP256R1())


def main():
    if "--emit-der-base64" in sys.argv:
        # The exact blob embedded in .github/workflows/android.yml.
        der = derive_key().private_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        import base64 as _b64

        print(_b64.b64encode(der).decode())
        return

    out = sys.argv[1] if len(sys.argv) > 1 else "build/release.p12"
    out = os.path.abspath(out)
    os.makedirs(os.path.dirname(out), exist_ok=True)

    key = derive_key()
    name = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, "SpotiDuck"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "SpotiDuck"),
        ]
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(0x5D0715D0C6)
        .not_valid_before(datetime.datetime(2024, 1, 1, tzinfo=datetime.timezone.utc))
        .not_valid_after(datetime.datetime(2054, 1, 1, tzinfo=datetime.timezone.utc))
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(key, hashes.SHA256())
    )

    blob = pkcs12.serialize_key_and_certificates(
        ALIAS,
        key,
        cert,
        None,
        serialization.BestAvailableEncryption(PASSWORD.encode()),
    )
    with open(out, "wb") as fh:
        fh.write(blob)
    print(f"wrote {out} ({len(blob)} B) — alias {ALIAS.decode()}, password {PASSWORD}")


if __name__ == "__main__":
    main()
