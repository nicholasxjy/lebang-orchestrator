export interface CommandIo {
    stdout(value: string): void;
    stderr(value: string): void;
}
export interface CommandOptions {
    cwd?: string;
    defaultRepo?: string;
    io?: CommandIo;
}
export declare const helpText = "usage: orchestrator [--repo PATH] [--config PATH] COMMAND [ARG]\n\ncommands:\n  init         create .orchestrator/config.json for this project\n  plan GOAL    plan a user goal through lebang\n  run          run ready tasks through the full lifecycle\n  status       show persisted orchestration status\n  task ID      show one persisted task\n  retry ID     retry a stopped task with its owner\n  review ID    rerun review for a task\n  integrate    integrate approved task commits\n  resume       recover interrupted orchestration state\n  graph        print the task DAG in DOT format\n  logs ID      print preserved agent logs for a task\n";
export declare function executeCommand(argv: readonly string[], options?: CommandOptions): Promise<number>;
