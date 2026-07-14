export interface AgentDescriptor {
  id: string;
  provider: string;
  model: string;
  deterministic: boolean;
}

export interface AgentResponse<Output> {
  output: Output;
  elapsedMs: number;
  raw: unknown;
}

export interface AgentAdapter<Input, Output> {
  readonly descriptor: AgentDescriptor;
  invoke(input: Input): Promise<AgentResponse<Output>>;
}

export class FunctionAgentAdapter<Input, Output> implements AgentAdapter<
  Input,
  Output
> {
  public constructor(
    public readonly descriptor: AgentDescriptor,
    private readonly implementation: (input: Input) => Output | Promise<Output>,
  ) {}

  public async invoke(input: Input): Promise<AgentResponse<Output>> {
    const startedAt = performance.now();
    const output = await this.implementation(input);
    return {
      output,
      elapsedMs: performance.now() - startedAt,
      raw: output,
    };
  }
}
