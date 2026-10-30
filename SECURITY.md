# Security policy

Career Agent runs locally and handles personal data, so security reports are welcome.

## Reporting a vulnerability

Please report privately through GitHub's private vulnerability reporting for this repository (**Security → Report a vulnerability**). Do not open a public issue for security problems.

Include what you found, how to reproduce it (with fictional data only), and the impact you expect. You will get an acknowledgement, and fixes are released as soon as they are verified.

## Scope

In scope: anything that could let Career Agent submit without your approval, leak your data or secrets (to logs, prompts, other origins, or other processes), let a job page or document steer the tool, or bypass the local API's protections.

Out of scope: attacks that already require control of your user account or machine (see residual risks in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)), and reports about third-party job sites or AI providers themselves.

## Design references

[Threat model](docs/THREAT_MODEL.md) · [Approval model](docs/APPROVAL_MODEL.md) · [Prompt security](docs/PROMPT_SECURITY.md) · [Decisions](docs/DECISIONS.md)
