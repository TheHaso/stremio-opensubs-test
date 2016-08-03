var _ = require("underscore");
var fs = require("fs");
var needle = require("needle");
var opensub = new (require("opensubtitles"))();

function hash(args, cb)
{
    if (typeof(args.url) !== "string") return cb(new Error("url required"));

    var cb = _.once(cb);
    var res = { };

    var chunk_size = 65536;
    var buf_start = new Buffer(chunk_size*2);
    var buf_end = new Buffer(chunk_size*2);
    var buf_pad = new Buffer(chunk_size);
    var file_size = 0;
    var t_chksum = [];

    var fd;

    var ready = function(chksum_part, name) {
        if (fd) fs.close(fd); fd = null;
        t_chksum.push(chksum_part);

        if(t_chksum.length == 3) {
            var chksum = opensub.sumHex64bits(t_chksum[0], t_chksum[1]);
            chksum = opensub.sumHex64bits(chksum, t_chksum[2]);
            chksum = chksum.substr(-16);
            res.hash = opensub.padLeft(chksum, "0", 16);
            cb(null, res);
        }
    };

    if (args.url.match("^file:")) {
        var p = args.url.slice("file://".length);
        return fs.stat(p, function(err, stat) {
            if(err) return cb(err);

            file_size = res.size = stat.size;
            ready(file_size.toString(16), "filesize");

            fs.open(p, "r", function(err,f) {
                fd = f;
                if(err) return cb(err);
                [{buf:buf_start, offset:0}, {buf:buf_end, offset:file_size-chunk_size}].forEach(function(b) {
                    fs.read(fd, b.buf, 0, chunk_size*2, b.offset, function(err, _, buffer) {
                        if(err) return cb(err);
                        ready(opensub.checksumBuffer(buffer, 16), "buf");
                    });
                });
            });
        });
    }
    
    if (args.url.match(/^http(s?):/)) return needle.head(args.url, { open_timeout: 60*1000 }, function(err, resp) {
        if (err) return cb(err);

        ready((res.size = file_size = parseInt(resp.headers["content-length"], 10)).toString(16), "filesize");
        [{start: 0, end: chunk_size-1 }, { start: file_size - chunk_size, end: file_size - 1 }].forEach(function(range) {
            needle.get(args.url, { headers: { range: "bytes="+range.start+"-"+range.end, "enginefs-prio": 10 }, open_timeout: 60*1000 }, function(err, resp) {
                if (err) return cb(err);
                if (resp.raw.length != chunk_size) cb(new Error("response for calculating movie hash is wrong length: "+JSON.stringify(range)+" chunk_size "+chunk_size+" but received "+resp.raw.length), res);
                ready(opensub.checksumBuffer(Buffer.concat([resp.raw, buf_pad]), 16), "buf");
            });
        });
    });        

    return cb(new Error("args.url must begin with http or file"));
};

module.exports = hash;
