#!/usr/bin/env bash
# Generate the test-only push signing keys the push-adapter tests `include_str!`
# at compile time. These are throwaway PKCS#8 keys — they are gitignored
# (`*.pem`) and must never be committed; ES256/RS256 tests sign with them but
# never assert exact signature bytes (ECDSA is non-deterministic), so any valid
# key of the right type works. Idempotent: existing local keys are kept.
set -euo pipefail

push_dir="$(cd "$(dirname "$0")/.." && pwd)/crates/frick-server/src/push"

if [ ! -f "$push_dir/test_ec_key.pem" ]; then
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
    -out "$push_dir/test_ec_key.pem"
  echo "generated $push_dir/test_ec_key.pem"
fi

if [ ! -f "$push_dir/test_rsa_key.pem" ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
    -out "$push_dir/test_rsa_key.pem"
  echo "generated $push_dir/test_rsa_key.pem"
fi

echo "push test keys ready in $push_dir"
