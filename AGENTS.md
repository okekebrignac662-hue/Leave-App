# Agent & Tool Permissions Guidelines

## Autonomous Execution Rules
- **Full Autonomous Mode**: Always execute necessary commands, file edits, migrations, and automated tests proactively without waiting for manual confirmation on safe operations.
- **Terminal Execution**: Automatically run `node`, `git`, and test commands to verify code changes immediately.
- **File Management**: Automatically create, update, and manage project files without asking for repetitive confirmation.
- **Database & Services**: Safely manage database migrations and ensure synchronization with PostgreSQL / Supabase.
- **Language**: Respond to the user in polite, clear Thai.
