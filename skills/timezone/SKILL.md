# Timezone

Resolves the user's local time when an agent needs to answer "what time is it"
or schedule something relative to "now."

The user is in America/New_York (US Eastern). When the user says "today",
"this morning", "tomorrow", interpret in that zone unless they say otherwise.

When constructing dates for cron expressions or scheduled_tasks, store the cron
in UTC but convert from US Eastern when the user describes the time in plain
language.
