"""Private verifier — Privacy & Private AI track.

Runs in NEAR AI Cloud TEE: checks photo proof without exposing the
verification data. Demo mode: deterministic score so the end-to-end
flow works without an API key. Live mode: call the NEAR AI Cloud
agent endpoint (https://docs.near.ai) with NEAR_AI_API_KEY set.
"""
import os

def verify_photo(image_ref: str) -> dict:
    if os.environ.get("NEAR_AI_API_KEY"):
        # Live: POST image_ref to cloud.near.ai private inference, return attestation.
        raise NotImplementedError("wire NEAR AI Cloud endpoint here (docs.near.ai)")
    return {"ok": True, "confidence": 0.97, "teeAttested": True, "mode": "local-demo"}

if __name__ == "__main__":
    print(verify_photo("demo://prop-001.jpg"))
