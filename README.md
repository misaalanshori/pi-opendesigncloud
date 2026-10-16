# pi-opendesigncloud

Pi provider extension for [OpenDesign AI](https://amr-link.open-design.ai/v1).

## Features

- **Standard Wire Compatibility**: Connects to OpenDesign via standard `openai-completions` API stream.
- **Login Integration**: Appears under **"Sign in with an API key"** when running `/login` in Pi, storing credentials safely in `~/.pi/agent/auth.json`.
- **Environment Variable Fallback**: Automatically recognizes `OPENDESIGN_API_KEY`.
- **Dynamic Model Discovery**: Queries `GET /v1/models` on refresh to discover newly added models, with offline fallback to built-in catalog definitions.
- **Extended Reasoning Support**: Native support for models returning reasoning traces (DeepSeek, Kimi, GLM, etc.).

## Models

Preconfigured with the OpenDesign model catalog:

| Model ID | Context Limit | Output Budget | Modalities |
|---|---|---|---|
| `deepseek-v4.1-flash` *(default)* | 1,048,000 | 32,000 | text, image |
| `deepseek-v4-flash` | 1,048,000 | 32,000 | text |
| `deepseek-v4-flash-vision-exp` | 1,048,000 | 32,000 | text, image |
| `deepseek-v4-pro` | 1,048,000 | 32,000 | text |
| `claude-haiku-5.5` | 1,000,000 | 32,000 | text, image |
| `glm-5.3-flash` | 1,048,000 | 32,000 | text, image |
| `glm-5.3-flashx` | 1,000,000 | 32,000 | text, image |
| `gpt-6-luna` | 1,050,000 | 32,000 | text, image |
| `kimi-k2.7-code` | 262,000 | 32,000 | text, image |
| `mimo-v2.6-flash` | 1,048,000 | 32,000 | text, image |
| `mimo-v2.6-pro` | 1,048,000 | 32,000 | text, image |

## Installation & Usage

### 1. Test directly with Pi

```bash
pi -e . --provider opendesign --model deepseek-v4.1-flash
```

Or install persistently into your Pi configuration:

```bash
pi install .
```

### 2. Sign In

Run `/login` in Pi and select:
1. **"Sign in with an API key"**
2. Choose **"OpenDesign"**
3. Paste your API key (`sk-amr-...`)

Alternatively, export the key in your shell:

```bash
export OPENDESIGN_API_KEY="sk-amr-..."
```

## Development & Testing

```bash
# Run isolated unit tests
npm test

# Run strict TypeScript verification
npm run typecheck
```
