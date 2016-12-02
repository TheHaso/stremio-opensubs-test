# stremio-opensubtitles

OpenSubtitles add-on for Stremio.

Functionalities include:

* Find subtitle files for the currently playing video
* Calculate opensubtitles video hash for currently playing video
* Load and parse an srt file into individual tracks

## Proxying to `vtt` or `srt`

Often when building web applications, or doing casting to limited devices, it's important that we can serve a clean, UTF8 encoded `.srt` or `.vtt` file, often with CORS support.

This add-on has a function which it exports called `proxySrtOrVtt` which would proxy any URL to an `srt` or `vtt`, which may be zipped or gzipped, to a UTF8-encoded VTT or SRT.

How to use with connect/express:

```
var subtitles = require("stremio-opensubtitles");
app.get("/subtitles.:ext", subtitles.proxySrtOrVtt);
```

Example on the front-end:

```
"http://localhost:8080/subtitles.vtt?from="+encodeURIComponent(urlToOpenSubtitlesGz)
```
