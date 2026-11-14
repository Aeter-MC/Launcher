# Native V2 · Windows x64

Use the instance menu to create a desktop shortcut. Aeter prepares the launch plan using the current account and the instance settings, with launcher settings as defaults. Recreate the shortcut after changing those settings.

The shortcut starts `AeterNative.exe`, which starts the selected Java runtime and tracks playtime and Discord Rich Presence. The Java bootstrap receives game arguments through a pipe. Shortcuts support Microsoft and offline accounts.

Build with `npm run native:v2`. Windows packages include the runner and bootstrap in `app.asar`. See [BUILD.md](../BUILD.md) for requirements.

Instance shortcut creation is currently unavailable on Linux.
