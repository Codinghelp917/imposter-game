# Imposter game — picture icon version

This build includes the earlier turn-based 30-second clue system and black starry UI, plus automatic picture avatars.

## Picture icons

Put your avatar images in:

`public/images/icons/`

Supported: `.png`, `.webp`, `.jpg`, `.jpeg`, `.gif`, `.svg`.

The server scans that folder automatically and sends the available icons to the browser. You do **not** need to edit an avatar filename array when adding or removing pictures. Restart the Node app after changing the files if your hosting platform keeps a long-running process.

The chosen image is used in the lobby, chat, turn order, voting, ejection and scoreboard.

A `detective-dog.png` example is included from the image supplied in chat. Keep your own existing images in the same folder.
