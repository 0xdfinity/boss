//! boss_market — the cross-firm job market.
//!
//! This contract is the only thing two independent BOSS instances have to
//! agree on. A client escrows money against a job spec; a worker delivers; the
//! client (or a third-party arbiter) releases. Nobody has to trust the other
//! firm, because neither firm holds the funds.
//!
//! Deliberate limits of this version:
//!   * the deliverable itself is not on chain, only its hash — hashing arbitrary
//!     prose into storage would cost more than the job is worth
//!   * there is no arbiter panel, only one optional arbiter account and a
//!     deadline. A panel is real design work; a timeout is honest today.
//!   * a job cannot be edited after it is opened. Cancel it and open a new one.

use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, AccountId, NearToken, Promise};

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq)]
pub enum JobStatus {
    Open,
    Submitted,
    Released,
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Job {
    pub id: u64,
    pub client: AccountId,
    pub worker: Option<AccountId>,
    pub capability: String,
    pub spec_hash: String,
    pub spec_url: String,
    pub deposit: U128,
    pub created_at: u64,
    pub deadline: u64,
    pub result_hash: String,
    pub result_url: String,
    pub status: JobStatus,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct AgentStats {
    pub jobs_done: u64,
    pub jobs_failed: u64,
    pub earned: U128,
}

impl Default for AgentStats {
    fn default() -> Self {
        Self {
            jobs_done: 0,
            jobs_failed: 0,
            earned: U128(0),
        }
    }
}

#[near(contract_state)]
pub struct BossMarket {
    pub owner: AccountId,
    /// Optional third party allowed to settle either way. `None` means only the
    /// client can release and only the client (or the deadline) can refund.
    pub arbiter: Option<AccountId>,
    pub jobs: Vector<Job>,
    /// Ids of jobs that were opened. Readers skip the ones that are no longer
    /// open, which is cheaper than deleting from the middle of a vector.
    pub index: Vector<u64>,
    pub stats: LookupMap<AccountId, AgentStats>,
    pub released: u64,
    pub refunded: u64,
}

impl Default for BossMarket {
    fn default() -> Self {
        Self {
            owner: env::current_account_id(),
            arbiter: None,
            jobs: Vector::new(b"jobs".to_vec()),
            index: Vector::new(b"index".to_vec()),
            stats: LookupMap::new(b"stats".to_vec()),
            released: 0,
            refunded: 0,
        }
    }
}

#[near]
impl BossMarket {
    #[init]
    pub fn new(arbiter: Option<AccountId>) -> Self {
        Self {
            arbiter,
            ..Self::default()
        }
    }

    /// Open a job and escrow the attached deposit. Returns the job id.
    ///
    /// `spec_url` is where the full brief lives. The chain only keeps the hash,
    /// because storing prose on chain would cost more than the job is worth.
    #[payable]
    pub fn open_job(
        &mut self,
        capability: String,
        spec_hash: String,
        spec_url: String,
        deadline_secs: u64,
    ) -> u64 {
        let deposit = env::attached_deposit();
        assert!(
            deposit > NearToken::from_yoctonear(0),
            "open_job must escrow a deposit"
        );
        assert!(!capability.is_empty(), "capability is required");
        assert!(!spec_hash.is_empty(), "spec_hash is required");
        assert!(!spec_url.is_empty(), "spec_url is required");
        // Ten seconds is short for production and deliberate for testnet: the
        // expiry-refund path has to be demonstrable in one sitting.
        assert!(
            deadline_secs >= 10 && deadline_secs <= 60 * 60 * 24 * 30,
            "deadline must be between 10 seconds and 30 days"
        );

        let now = env::block_timestamp() / 1_000_000_000;
        let id = self.jobs.len() as u64;
        let client = env::predecessor_account_id();
        let job = Job {
            id,
            client: client.clone(),
            worker: None,
            capability,
            spec_hash,
            spec_url,
            deposit: U128(deposit.as_yoctonear()),
            created_at: now,
            deadline: now + deadline_secs,
            result_hash: String::new(),
            result_url: String::new(),
            status: JobStatus::Open,
        };
        self.jobs.push(job);
        self.index.push(id);
        env::log_str(&format!("job_opened id={} by={}", id, client));
        id
    }

    /// Claim and deliver a job in one call. The caller becomes the worker.
    pub fn submit(&mut self, job_id: u64, result_hash: String, result_url: String) {
        let mut job = self.load(job_id);
        assert!(job.status == JobStatus::Open, "job is not open");
        assert!(!result_hash.is_empty(), "result_hash is required");

        let caller = env::predecessor_account_id();
        assert!(
            caller != job.client,
            "a client cannot deliver its own job"
        );

        job.worker = Some(caller.clone());
        job.result_hash = result_hash;
        job.result_url = result_url;
        job.status = JobStatus::Submitted;
        self.jobs.set(job_id as u32, job);

        env::log_str(&format!("job_submitted id={} by={}", job_id, caller));
    }

    /// Pay the worker. Caller must be the client or the arbiter.
    pub fn release(&mut self, job_id: u64) -> Promise {
        let mut job = self.load(job_id);
        assert!(job.status == JobStatus::Submitted, "job is not submitted");
        self.assert_settler(&job);

        let worker = job.worker.clone().expect("submitted job has a worker");
        let amount = job.deposit;

        job.status = JobStatus::Released;
        self.jobs.set(job_id as u32, job);
        self.released += 1;

        let mut stats = self.stats.get(&worker).cloned().unwrap_or_default();
        stats.jobs_done += 1;
        stats.earned = U128(stats.earned.0 + amount.0);
        self.stats.insert(worker.clone(), stats);

        env::log_str(&format!(
            "job_released id={} worker={} amount={}",
            job_id, worker, amount.0
        ));
        Promise::new(worker).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// Return the deposit to the client. Allowed before anyone submits, or by
    /// anyone once the deadline has passed, so a silent client cannot strand a
    /// worker's escrow forever.
    pub fn refund(&mut self, job_id: u64) -> Promise {
        let mut job = self.load(job_id);
        assert!(
            job.status == JobStatus::Open || job.status == JobStatus::Submitted,
            "job is already settled"
        );

        let caller = env::predecessor_account_id();
        let now = env::block_timestamp() / 1_000_000_000;
        let expired = now >= job.deadline;
        if job.status == JobStatus::Submitted {
            assert!(
                caller == job.client || can_arbitrate(&self.arbiter, &caller) || expired,
                "only the client or the arbiter can refund a submitted job before its deadline"
            );
        } else {
            assert!(
                caller == job.client || expired,
                "only the client can cancel an open job"
            );
        }

        let client = job.client.clone();
        let amount = job.deposit;

        // A submitted job that is refunded is a failed delivery; an open job
        // that is cancelled is not the worker's fault (there is no worker).
        if job.status == JobStatus::Submitted {
            if let Some(worker) = job.worker.clone() {
                let mut stats = self.stats.get(&worker).cloned().unwrap_or_default();
                stats.jobs_failed += 1;
                self.stats.insert(worker, stats);
            }
        }

        job.status = JobStatus::Refunded;
        self.jobs.set(job_id as u32, job);
        self.refunded += 1;

        env::log_str(&format!(
            "job_refunded id={} client={} amount={}",
            job_id, client, amount.0
        ));
        Promise::new(client).transfer(NearToken::from_yoctonear(amount.0))
    }

    // views
    pub fn get_job(&self, job_id: u64) -> Job {
        self.load(job_id)
    }

    pub fn job_count(&self) -> u64 {
        self.jobs.len() as u64
    }

    /// Open jobs, newest first, skipping ones already claimed or settled.
    pub fn open_jobs(&self, from: u64, limit: u32) -> Vec<Job> {
        self.page(from, limit, true)
    }

    pub fn recent_jobs(&self, from: u64, limit: u32) -> Vec<Job> {
        self.page(from, limit, false)
    }

    pub fn agent_stats(&self, account: AccountId) -> AgentStats {
        self.stats.get(&account).cloned().unwrap_or_default()
    }

    pub fn config(&self) -> (AccountId, Option<AccountId>, u64, u64, u64) {
        (
            self.owner.clone(),
            self.arbiter.clone(),
            self.jobs.len() as u64,
            self.released,
            self.refunded,
        )
    }

    // internal
    fn load(&self, job_id: u64) -> Job {
        self.jobs
            .get(job_id as u32)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no such job"))
    }

    fn page(&self, from: u64, limit: u32, only_open: bool) -> Vec<Job> {
        let limit = limit.min(50) as u64;
        let mut out = Vec::new();
        let len = self.index.len() as u64;
        if from >= len || limit == 0 {
            return out;
        }
        // Walk backwards from `from` (offset from the newest job) so a worker
        // polling for work sees fresh jobs first.
        let mut seen = 0u64;
        let mut i = len.saturating_sub(1 + from);
        loop {
            if let Some(id) = self.index.get(i as u32) {
                if let Some(job) = self.jobs.get(*id as u32) {
                    if !only_open || job.status == JobStatus::Open {
                        out.push(job.clone());
                        seen += 1;
                        if seen >= limit {
                            break;
                        }
                    }
                }
            }
            if i == 0 {
                break;
            }
            i -= 1;
        }
        out
    }

    fn assert_settler(&self, job: &Job) {
        let caller = env::predecessor_account_id();
        assert!(
            caller == job.client || can_arbitrate(&self.arbiter, &caller),
            "only the client or the arbiter can release"
        );
    }
}

fn can_arbitrate(arbiter: &Option<AccountId>, caller: &AccountId) -> bool {
    match arbiter {
        Some(a) => a == caller,
        None => false,
    }
}
