var addons = require("stremio-addons");
var http = require("http");
var _ = require("underscore");
var moment = require("moment");
var url = require("url");

/* Clusterify */
var cluster = require('cluster');
if (process.env.WEB_CONCURRENCY && cluster.isMaster) {
	var numCPUs = process.env.WEB_CONCURRENCY || require('os').cpus().length;

	for (var i = 0; i < numCPUs; i++) { cluster.fork() }
	
	cluster.on("exit", function(worker) {
		console.log("worker %s died, restarting in 5s", worker.process.pid); 
		setTimeout(function() { cluster.fork() }, 5*1000);
	});

	return;
}

/* Basic glue
 */
var find = require("./lib/find");
var tracks = require("./lib/tracks");
var hash = require("./lib/hash");

function subsFind(args, cb) {
	find(args, function(err, res) {
		if (err || !res) return cb(err, res);

		// Do not serve .zip subtitles unless we explicitly allow it
		if (!args.supportsZip) _.each(res.subtitles, function(group, key) {
			res.subtitles[key] = group.filter(function(sub) { return sub.url && !sub.url.match("zip$") });
		});

		cb(err, res);
	});		
}


var service = new addons.Server({
	"subtitles.get": subsFind,
	"subtitles.find": function(args, cb) {

		if (! args.query) return cb({ code: 13, message: "query required" });

		subsFind(args, function(err, res) {
			if (err) return cb(err);
			if (! (res && res.subtitles)) return cb(null, res);

			var all = _.chain(res.subtitles).map(function(list, lang) { 
				return (Array.isArray(list) ? list : []).map(function(x) {
					x.lang = lang;
					if (res.blacklisted && res.blacklisted.indexOf(x.id) > -1) x.priority = -1;
					else if (res.moviehash_picks && res.moviehash_picks.indexOf(x.id) > -1) x.priority = 1;
					return x;
				});
			}).flatten().value();
			cb(null, { id: args.query.videoHash || args.query.itemHash, all: all })
		});
	},
	"subtitles.tracks": tracks,
	"subtitles.hash": hash,
	"stats.get": function(args, cb, user) {

		var pkg = require("./package"); 
		cb(null, { name: pkg.name, version: pkg.version, stats: [{name: "subtitles", colour:"green"}], statsNum: "~ 3000000 subtitle files" });
	}
},  { stremioget: true, allow: ["http://api9.strem.io"] }, require("./stremio-manifest"));

// TODO: this should be able to handle delay
service.proxySrtOrVtt = function(req, res) {
	// req.params.delay
	var isVtt = req.params.ext === "vtt"; // we can set it to false for srt
	var query = url.parse(req.url, true).query;
	service.request("subtitles.tracks", [{ stremioget: true }, { url: query.from }], function(err, handle) {
		if (err) {
			console.error(err);
			res.writeHead(500);
			res.end();
			return;
		}
		if (isVtt) res.write("WEBVTT\n\n");
		var format = function(d) {
			return isVtt ? moment(d).utcOffset(0).format("HH:mm:ss.SSS") : moment(d).utcOffset(0).format("HH:mm:ss,SSS")
		}
		handle.tracks.forEach(function(track, i) {
			res.write(i.toString()+"\n");
			res.write(format(track.startTime) + " --> " + format(track.endTime) +"\n");
			res.write(track.text.replace(/&/g, "&amp;")+"\n\n"); // TODO: sanitize?
		});
		res.end();
	});
}
module.exports = service;

/* Init server
 */
if (require.main==="stremio-opensubtitles") {
	var server = http.createServer(function (req, res) {
	  service.middleware(req, res, function() { res.end() });
	}).listen(process.env.PORT || 3011).on("listening", function()
	{
		console.log("Subtitles listening on "+server.address().port);
	});	
}
