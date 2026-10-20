# Live Gateway end-to-end

Runs a real OpenClaw Gateway with Kalinov installed and a scripted OpenAI-compatible "model" that calls
`write` / `edit` / `apply_patch` on command. Everything between the model and the file system is the real
host: tool policy, the `before_tool_call` pipeline, `session_end`.

```
node scripts/live-e2e/mock-model.mjs &                       # :18900, logs tool results to $MOCK_LOG
openclaw plugins install -l . --accept-capabilities
openclaw config set models.providers.mock '{"baseUrl":"http://127.0.0.1:18900/v1","apiKey":"x","api":"openai-completions","models":[{"id":"mock-1","name":"mock","reasoning":false,"input":["text"],"contextWindow":32000,"maxTokens":4000,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}]}' --strict-json
openclaw config set agents.defaults.model.primary mock/mock-1
openclaw gateway run --allow-unconfigured &
openclaw agent --session-key agent:main:t1 -m '@@write@@{"path":"MEMORY.md","content":"- User said: SQLite only for prototype A\n"}@@'
openclaw agent --session-key agent:main:t1 -m '@@write@@{"path":"MEMORY.md","content":"- User said: SQLite only for prototype A\n- user prefers SQLite\n"}@@'   # -> EpistemicConflictError
```

Message format: `@@<tool>@@<json arguments>@@`. The mock's second turn echoes the tool result into
`$MOCK_LOG` (`toolresult` field), which is exactly what the agent saw.
