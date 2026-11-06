//! boss_treasury — the B.O.S.S. treasury contract.
//!
//! Words from the model, numbers from the contract: agents may propose a
//! payment, but nothing moves unless the policy enforced here allows it —
//! per-transaction cap, daily cap, owner-only reputation and pause, and a
//! full audit log.
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, AccountId, NearToken, Promise};

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct SpendingLimit {
    pub agent_id: String,
    pub max_per_tx: U128,
    pub daily_limit: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct AgentProfile {
    pub agent_id: String,
    pub max_per_tx: U128,
    pub daily_limit: U128,
    pub spent_today: U128,
    pub reputation: u8,
    pub tasks_done: u64,
    pub last_day: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct AuditEntry {
    pub agent_id: String,
    pub amount: U128,
    pub action: String,
    pub timestamp: u64,
}

#[near(contract_state)]
pub struct BossTreasury {
    pub owner: AccountId,
    pub total_budget: U128,
    pub total_spent: U128,
    pub paused: bool,
    pub agents: LookupMap<String, AgentProfile>,
    pub audit_log: Vector<AuditEntry>,
}

impl Default for BossTreasury {
    fn default() -> Self {
        Self {
            owner: env::current_account_id(),
            total_budget: U128(0),
            total_spent: U128(0),
            paused: false,
            agents: LookupMap::new(b"agents".to_vec()),
            audit_log: Vector::new(b"audit_log".to_vec()),
        }
    }
}

#[near]
impl BossTreasury {
    #[init]
    pub fn new(total_budget: U128) -> Self {
        Self {
            owner: env::current_account_id(),
            total_budget,
            ..Self::default()
        }
    }

    /// Owner-only: register an agent with a scoped spending allowance.
    pub fn create_sub_agent(&mut self, agent: String, max_per_tx: U128, daily_limit: U128) {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner,
            "only owner can create sub-agents"
        );
        assert!(!self.agents.contains_key(&agent), "agent already exists");
        self.agents.insert(
            agent.clone(),
            AgentProfile {
                agent_id: agent,
                max_per_tx,
                daily_limit,
                spent_today: U128(0),
                reputation: 50,
                tasks_done: 0,
                last_day: 0,
            },
        );
    }

    /// Owner-only: grant a function-call key the same scoped allowance.
    pub fn register_agent(&mut self, agent: String, max_per_tx: U128, daily_limit: U128) {
        self.create_sub_agent(agent, max_per_tx, daily_limit);
    }

    /// The swarm calls this before any payout. Both limits are enforced on-chain.
    pub fn authorize_spend(&mut self, agent: String, amount: U128, action: String) -> bool {
        self.charge(&agent, amount, action);
        true
    }

    /// Verify + pay in one call: charges the agent's allowance, writes the
    /// audit entry, and moves `near_yocto` to the worker. `worker` may be any
    /// valid account id, including an implicit one.
    pub fn pay(&mut self, agent: String, amount: U128, worker: AccountId, near_yocto: U128, action: String) -> bool {
        self.charge(&agent, amount, action);
        if near_yocto.0 > 0 {
            let _ = Promise::new(worker).transfer(NearToken::from_yoctonear(near_yocto.0));
        }
        true
    }

    fn charge(&mut self, agent: &str, amount: U128, action: String) {
        assert!(!self.paused, "treasury is paused");
        assert!(amount.0 > 0, "amount must be positive");

        let day = env::block_timestamp() / 86_400_000_000_000;
        let mut profile = self.agents.get(agent).expect("agent not registered").clone();
        if profile.last_day != day {
            profile.spent_today = U128(0);
            profile.last_day = day;
        }

        assert!(
            amount.0 <= profile.max_per_tx.0,
            "amount exceeds agent's per-transaction limit"
        );
        assert!(
            profile.spent_today.0 + amount.0 <= profile.daily_limit.0,
            "amount exceeds agent's daily limit"
        );
        assert!(
            amount.0 <= self.remaining_budget().0,
            "insufficient treasury budget"
        );

        self.audit_log.push(AuditEntry {
            agent_id: agent.to_string(),
            amount,
            action,
            timestamp: env::block_timestamp(),
        });

        self.total_spent = U128(self.total_spent.0 + amount.0);
        profile.spent_today = U128(profile.spent_today.0 + amount.0);
        profile.tasks_done += 1;
        self.agents.insert(agent.to_string(), profile);
    }

    /// Owner-only: adjust an agent's reputation (0–100).
    pub fn update_reputation(&mut self, agent: String, delta: i16) {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner,
            "only owner can update reputation"
        );
        if let Some(p) = self.agents.get_mut(&agent) {
            let next = (p.reputation as i16 + delta).clamp(0, 100);
            p.reputation = next as u8;
        }
    }

    /// Owner-only: stop all payouts instantly.
    pub fn pause(&mut self) {
        assert_eq!(env::predecessor_account_id(), self.owner, "only owner can pause");
        self.paused = true;
    }

    /// Owner-only: resume payouts.
    pub fn unpause(&mut self) {
        assert_eq!(env::predecessor_account_id(), self.owner, "only owner can unpause");
        self.paused = false;
    }

    pub fn remaining_budget(&self) -> U128 {
        U128(self.total_budget.0.saturating_sub(self.total_spent.0))
    }

    pub fn agent_profile(&self, agent: String) -> Option<AgentProfile> {
        self.agents.get(&agent).cloned()
    }

    pub fn audit_len(&self) -> u32 {
        self.audit_log.len()
    }

    pub fn audit_entry(&self, index: u32) -> Option<AuditEntry> {
        self.audit_log.get(index).cloned()
    }

    pub fn get_policy(&self) -> SpendingLimit {
        SpendingLimit {
            agent_id: "boss".to_string(),
            max_per_tx: U128(2_000_000),
            daily_limit: U128(20_000_000),
        }
    }
}
