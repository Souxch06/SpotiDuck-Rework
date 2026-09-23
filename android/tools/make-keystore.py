#!/usr/bin/env python3
"""Creates the release signing key used by `.github/workflows/android.yml`.

    pip install cryptography
    python3 android/tools/make-keystore.py            # writes build/release.p12

Then store it once, as repository secrets (GitHub CLI):

    base64 -w0 build/release.p12 | gh secret set SD_KEYSTORE_BASE64
    gh secret set SD_KEYSTORE_PASSWORD --body "<password>"
    gh secret set SD_KEY_ALIAS        --body "spotiduck"
    gh secret set SD_KEY_PASSWORD     --body "<password>"

Keep the generated `.p12` **out of the repository** (it is git-ignored) and
somewhere safe: it is what makes an installed SpotiDuck upgradable. Losing it
only means users have to uninstall before installing a newer build.
"""

import argparse
import base64
import datetime
import os
import sys

try:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import NameOID
except ImportError:
    sys.exit("cryptography is missing — run: pip install cryptography")

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build", "release.p12")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cn", default="SpotiDuck")
    ap.add_argument("--password", default="spotiduck")
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--years", type=int, default=30)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    if os.path.exists(out) and not args.force:
        sys.exit(f"{out} already exists — pass --force to overwrite (that changes the app signature!)")
    os.makedirs(os.path.dirname(out), exist_ok=True)

    key = rsa.generate_private_key(public_exponent=65537, key_size=4096)
    name = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, args.cn),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, args.cn),
            x509.NameAttribute(NameOID.COUNTRY_NAME, "FR"),
        ]
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=365 * args.years))
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

    # Java reads PKCS#12 keystores through the certificate's friendly name,
    # which is what `keyAlias` must match.
    blob = pkcs12.serialize_key_and_certificates(
        b"spotiduck",
        key,
        cert,
        None,
        serialization.BestAvailableEncryption(args.password.encode()),
    )

    with open(out, "wb") as fh:
        fh.write(blob)

    print(f"wrote {out} ({len(blob)} B)")
    print("alias    : spotiduck")
    print(f"password : {args.password}")
    print()
    print("store it once:")
    print("  base64 -w0 " + os.path.relpath(out) + " | gh secret set SD_KEYSTORE_BASE64")
    print(f"  gh secret set SD_KEYSTORE_PASSWORD --body '{args.password}'")
    print("  gh secret set SD_KEY_ALIAS --body 'spotiduck'")
    print(f"  gh secret set SD_KEY_PASSWORD --body '{args.password}'")
    print()
    print("base64 (for a manual copy):")
    print(base64.b64encode(blob).decode())


if __name__ == "__main__":
    main()
