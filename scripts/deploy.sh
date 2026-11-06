#!/usr/bin/env bash
# Deploy boss_treasury to testnet. Requires near-cli-rs + a funded testnet account.
set -euo pipefail
ACCOUNT="${NEAR_ACCOUNT:?set NEAR_ACCOUNT to your testnet account}"
near deploy --accountId "$ACCOUNT" --contracts ./target/wasm32-unknown-unknown/release/boss_treasury.wasm --initFunction new --initArgs '{"total_budget": "20000000"}' --networkId testnet || \
  near-cli-rs deploy --account-id "$ACCOUNT" --contracts ./target/wasm32-unknown-unknown/release/boss_treasury.wasm --init-function new --init-args '{"total_budget": "20000000"}' --network-id testnet
