use crate::{
    model::{ModelError, Task, TaskStatus},
    store::{RunStore, StoreError},
};

pub fn ready_task_ids(tasks: &[Task]) -> Vec<String> {
    let by_id = tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect::<std::collections::HashMap<_, _>>();
    let mut ready = tasks
        .iter()
        .filter(|task| {
            task.status == TaskStatus::Pending
                && task.dependencies.iter().all(|dependency| {
                    matches!(
                        by_id[dependency.as_str()].status,
                        TaskStatus::Approved | TaskStatus::Completed
                    )
                })
        })
        .map(|task| task.id.clone())
        .collect::<Vec<_>>();
    ready.sort();
    ready
}

pub fn transition_task(
    store: &RunStore,
    task: &mut Task,
    target: TaskStatus,
    agent: &str,
    reason: &str,
) -> Result<(), StoreError> {
    if !allowed_transition(task.status, target) {
        return Err(StoreError::Model(ModelError::Invalid {
            label: "task",
            detail: format!(
                "invalid task transition: {} -> {}",
                task.status.as_str(),
                target.as_str()
            ),
        }));
    }
    let previous = task.status;
    task.status = target;
    store.save_task(task)?;
    store.append_history(
        &task.id,
        &serde_json::json!({
            "event": "state_transition",
            "fromStatus": previous,
            "toStatus": target,
            "agent": agent,
            "reason": reason,
        }),
    )
}

pub const fn allowed_transition(from: TaskStatus, to: TaskStatus) -> bool {
    use TaskStatus as S;
    match from {
        S::Pending => matches!(to, S::Ready | S::Blocked | S::Failed | S::Invalidated),
        S::Ready => matches!(to, S::Running | S::Blocked | S::Failed | S::Invalidated),
        S::Running => matches!(
            to,
            S::SelfVerifying | S::Interrupted | S::Blocked | S::Failed
        ),
        S::SelfVerifying => matches!(to, S::Testing | S::Interrupted | S::Blocked | S::Failed),
        S::Testing => matches!(to, S::Reviewing | S::Interrupted | S::Blocked | S::Failed),
        S::Reviewing => matches!(
            to,
            S::Approved | S::ChangesRequested | S::Interrupted | S::Blocked | S::Failed
        ),
        S::ChangesRequested => matches!(to, S::Reworking | S::Blocked | S::Failed | S::Invalidated),
        S::Reworking => matches!(
            to,
            S::SelfVerifying | S::Testing | S::Interrupted | S::Blocked | S::Failed
        ),
        S::Approved => matches!(to, S::Integrating | S::Blocked | S::Invalidated),
        S::Integrating => matches!(to, S::Completed | S::Interrupted | S::Blocked | S::Failed),
        S::Interrupted => matches!(
            to,
            S::Ready
                | S::Reworking
                | S::Testing
                | S::Reviewing
                | S::Integrating
                | S::Blocked
                | S::Failed
                | S::Invalidated
        ),
        S::Failed => matches!(to, S::Ready | S::Reworking | S::Blocked | S::Invalidated),
        S::Blocked => matches!(to, S::Ready | S::Reworking | S::Failed | S::Invalidated),
        S::Completed | S::Invalidated => false,
    }
}
