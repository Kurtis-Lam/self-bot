### How autocatch works

The detector bot posts a message with a Pokémon name, and every logged-in account that can see it evaluates every active autocatch config. For each config, the engine parses the target field, a comma-separated list. Numeric parts are IDs (guild or channel), .json parts are Pokémon lists, and anything else is a Pokémon name.

No ID provided (empty target, or only Pokémon names / .json files):

In the server where the config was added, it catches every detection in all channels, with no ping needed.
In any other server, it now never catches, even if pinged. This is the fix.

ID provided (one or more numeric IDs):

In the server where the config was added, it only catches if the message’s server ID or channel ID is in your list.
In other servers, it catches only if your account is pinged in the detector message. This is unchanged from before.

Pokémon names in the target (with or without IDs):

If you list names, only those are caught. Names typed directly get top priority, .json lists come next, and an empty list means catch everything, at the lowest priority.
Excludes are checked before any of this and always win.
If several accounts qualify, the highest priority group wins. Within a group, accounts take turns, and the rotation by time of day and pairs is used for the lowest priority, catch-everything configs.
One account catches per message, after a 1–1.5 second delay.

One oddity in the cross-server rule is that it ignores which IDs you listed. It only checks that the config has some ID and that you were pinged. So a config with the ID of a channel in server B will also catch in server C if you’re pinged there. If you want it to catch only in the places you listed, I can add an ID match to that branch.