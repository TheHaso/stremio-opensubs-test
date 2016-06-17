
var async = require("async"),
	_ = require("lodash"),
	optimist = require("optimist"),    
	xmlrpc = require("xmlrpc"),
	needle = require("needle"),
	subGrouping = require("subtitles-grouping"),
	subGroupingAverage = require("subtitles-grouping/lib/grouping").average,
	OS = require("opensubtitles-api");

var OpenSubtitles = new OS("NodeOpensubtitles v0.0.1");

var MAX_RETRIES = 3;
var RETRY_PERIOD = 200; // ms
var ALGO_VERSION = "1.7";
var SUB_GROUPING_SENSITIVITY = 0.05;
var SUBTITLES_FOR_GROUPING = 8; // Number of subs used for generating the dominant group
var GROUPING_MAX_TIME = 2000; // ms
var GROUPING_DISABLED = true;

function getStaleTime(res) {
	if (process.env.NODE_ENV!="production") return 10*1000;
	var exists = Date.now() - res.added.getTime();
	if (exists < 24*60*60*1000) return 4*60*60*1000;
	if (exists > 30*24*60*60*1000) return 3*24*60*60*1000;
	return 24*60*60*1000;
}

var LANG_MAP = {
	"albanian":"sqi","arabic":"ara","bengali":"ben","bulgarian":"bul","bosnian":"bos","chinese":"zho","croatian":"hrv","czech":"cze",
	"danish":"dan","dutch":"nld","english":"eng","estonian":"est","farsi-persian":"per","finnish":"fin","french":"fre","german":"ger",
	"greek":"gre","hebrew":"heb","hungarian":"hun","indonesian":"ind","italian":"ita","japanese":"jpn","korean":"kor","lithuanian":"lit",
	"macedonian":"mkd","malay":"msa","norwegian":"nor","polish":"pol","portuguese":"por","romanian":"rum","russian":"rus","serbian":"srp",
	"slovenian":"slv","spanish":"spa","swedish":"swe","thai":"tha","turkish":"tur","urdu":"urd","ukrainian":"ukr","vietnamese":"vie", "brazilian-portuguese": "por"
};

/*
 * Unlike all the other crawlers, this one is on-demand; we call .find and it craws & saves subtitles
 */

/* Internal functions - interacting with OpenSubtitles
 */
var client = xmlrpc.createClient("http://api.opensubtitles.org/xml-rpc");

function opensubRequest(method, args, cb, retries) 
{
	retries = retries || 0;

	client.methodCall(method, args, function(err, res) {
		var retry = err || (method=="SearchSubtitles" && !(res && res.data));
		if (retry && retries>=MAX_RETRIES) return cb(err); // Give up

		if (retry) return setTimeout(function() { opensubRequest(method, args, cb, ++retries) }, RETRY_PERIOD);

		cb(err, res);
	});
};


var token = null;
function opensubToken(cb)
{
	if (token) return cb(null, token);

	debugLog("subtitles-crawler: getting opensubtitles token");
	// TODO: maybe implement token caching here
	opensubRequest("LogIn", ["", "", "en", "NodeOpensubtitles v0.0.1"], function(err, res) {
		if (err || !(res && res.token)) console.error("err, res:", err, res);

		if (err) return cb(err);
		if (! (res && res.token)) return cb(new Error("opensubToken: blank result returned from opensubtitles"));
		
		token = res.token;
		setTimeout(function() { token = null }, 30*60*1000);

		cb(err, res.token);
	});
};

/* Internal functions - subtitles related
 *  pickSubtitles(query, results from opensubtitles, results from yifi, instance of Subtitles, callback(err, instance of Subtitles))
 */
function pickSubtitles(query, res, subtitles) 
{    
	/* We don't support other subtitle formats; may be permanent if we have enough subtitles 
	 * TODO: sort by user rank, this might help
	 * also, filtering by parsing the subtitle file name and moviename might help if needed
	 * also, comparing moviefps can be +1 factor
	 * !! sub.MovieTimeMS - would be great but isn't used 
	 */

	res = res.filter(function(subtitle) { return subtitle.SubFormat == "srt" });

	// Remove subtitles with cd1/cd2 tags
	res = res.filter(function(subtitle) { 
		return !subtitle.SubFileName.match(/cd(.| )1|cd(.| )2/i);
	});

	res = res.filter(function(sub) {
		if ((parseInt(sub.SeriesIMDBParent, 10) || parseInt(sub.IDMovieImdb, 10)) != parseInt(query.meta.imdb_id.slice(2), 10)) return false;

		if (sub.SeriesIMDBParent!="0" && sub.hasOwnProperty("SeriesSeason") 
			&& (sub.SeriesSeason!=query.meta.season || sub.SeriesEpisode!=query.meta.episode)
		) return false;
		return true;
	});
	res = res.filter(function(sub) {
		return subtitles.blacklisted.indexOf(sub.IDSubtitle) == -1
	});
	debugLog("subtitles-crawler: "+res.length+" subtitles remained after blacklisting");

	/*
	res.forEach(function(x){ 
		x.nameScore = natural.JaroWinklerDistance(tag, x.MovieReleaseName);
	});
	*/

	/* Filter all the results that were matched in the metadata-based query; 
	 * that way we exclude matches by hash that are wrong
	 */
	//var matchedIds = _.indexBy(resQuery.data, "IDSubtitleFile");
	//res = res.filter(function(x) { return matchedIds[x.IDSubtitleFile] });


	/*
	 * First, apply a sort - moviehash / download count
	 * Then convert langs into a map of language->[subtitles for this language by priority]
	 * 
	 * After this implement a function getSubtitlesBuffer() and re-use if it needed in the async.each loop
	 */
	res.sort(function(b, a) {
		var byHash = (a.MatchedBy == "moviehash") - (b.MatchedBy == "moviehash");
		if (byHash != 0) return byHash;
		//return a.nameScore - b.nameScore;
		return a.SubDownloadsCnt - b.SubDownloadsCnt;
		// also use MovieReleaseName
	});
	res = _.uniq(res, false, function(x) { return x.IDSubtitle }); // de-duplication after the sorting

	var langs = _.groupBy(res, "SubLanguageID");
	var langRes = {};
	_.uniq(Object.keys(langs)).forEach(function(key) {
		langRes[key] = [];
		if (langs[key]) langs[key].forEach(function(x) { langRes[key].push({ 
			id: x.IDSubtitle, 
			url: x.SubDownloadLink && x.SubDownloadLink.replace("download/filead","download/subencoding-utf8/filead")
		}) });
	});
	debugLog("subtitles-crawler: found from opensubtitles "+_.size(langRes)+" sets of subtitles");

    subtitles.subtitles = langRes;
	_.extend(subtitles.query, query);
	if (query.item_hash) subtitles.item_hash = query.item_hash;
	subtitles.id = subtitles.item_hash.split(' ').join('-');

	return subtitles;
};

function debugLog()
{
	//optimist.argv["subtitles-crawler-debug"] && console.log.apply(console, arguments)
	console.log.apply(console, arguments);

};

/* Exported functions
 * alternativeFind - alternative search, Jean's opensubtitles-api module
 */
function alternativeFind(query, callback, retries) {

	retries = retries || 0;

	OpenSubtitles.login().then( function(token) {
		OpenSubtitles.search({
			sublanguageid: 'all',
			hash: query.movieHash || null,
			filesize: query.movieByteSize || null,
			filename: query.tag || null,
			extensions: ['srt', 'vtt'],
			limit: 'best',
			imdbid: query.meta && query.meta.imdb_id ? query.meta.imdb_id : null,
			season: query.meta && query.meta.season ? query.meta.season : null,
			episode: query.meta && query.meta.episode ? query.meta.episode : null
		}).then( function(subtitles) {
			var langRes = {};
			_.each( subtitles, function(el) {
				var iso6391 = LANG_MAP[el.langName.toLowerCase()];
				langRes[iso6391 || el.langName] = [{
					id: el.id,
					url: el.url.replace('/filead/', '/subencoding-utf8/filead/') + '.gz',
					lang: iso6391 || el.langName
				}];
			});

			callback(null, {
				subtitles: langRes,
				item_hash: query.item_hash,
				id: query.item_hash.split(' ').join('-')
			});

		}).catch(function(err){
			if (retry && retries>=MAX_RETRIES) return callback(err); // Give up
			retries++;
			alternativeFind(query, callback, retries);
		});
	});
}


/* Exported functions
 * findSubtitles - can take anything from 600ms to 3000ms
 */
function findSubtitles(args, callback)
{
	var query = args || { }; // for now
	
	// new format 
	if (args.query) {
		if (! args.query.itemHash) return callback({ code: 12, message: "query.itemHash required" });

		query.hash = args.query.itemHash;
		var split = args.query.itemHash.split(" ");
		query.meta = split.length > 1 ? { imdb_id: split[0], season: parseInt(split[1]), episode: parseInt(split[2]) } : { imdb_id: split[0] };
		if (args.query.videoHash) query.movieHash = args.query.videoHash;
		if (args.query.videoSize) query.movieByteSize = args.query.videoSize.toString();
		if (args.query.videoName) query.tag = args.query.videoName;
	}

	if (! query.hash) return callback({ code: 10, message: "findSubtitles requires hash" });
	if (! (query.meta && query.meta.imdb_id)) return callback({ code: 11, message: "findSubtitles requires item metadata (imdb_id, ?season, ?episode)" });

	var callback = _.once(callback);

	var subtitles = null; // Subtitles object in DB
	var langs = null; // All languages

	debugLog("subtitles-crawler: retrieving subtitles for "+query.hash);

	if (args.altFind || process.env.ALT_FIND) {
		alternativeFind(query, callback);
		return;
	}

	/* 
	 *  If the results are there, return them early, but continue with making the request; 
	 *  UNLESS we have made the same request in the last 60 min
	 */
	async.auto({
		subtitles: function(cb, res) { // Get the subtitles object in the DB
			setTimeout(function() {
				if (! subtitles) debugLog("subtitles-crawler: subtitles for - "+query.hash+" internal timeout - completed: "+(res && Object.keys(res).join(", "))+" subtitles is: "+JSON.stringify(subtitles));
			}, 15000);

			subtitles = {
				blacklisted: []
			};

			cb();

		},
		token: function(cb) { opensubToken(cb) },
		retrieve: ["subtitles", "token", function(cb, res) {

			var hashQuery = { moviebytesize: query.movieByteSize, moviehash: query.movieHash, sublanguageid: langs };
			var metaQuery = { imdbid: query.meta.imdb_id.slice(2), sublanguageid: langs };
			if (query.meta.hasOwnProperty("season")) _.extend(metaQuery, _.pick(query.meta, "season", "episode"));

			debugLog("subtitles-crawler: querying opensubtitles for "+query.hash, hashQuery, metaQuery);
			// TODO: two separate requests with 50-60 limit each
			opensubRequest("SearchSubtitles", [res.token, [hashQuery, metaQuery], { limit: 100 } ], cb);
		}],
		pick: ["retrieve", function(cb, res) {

			if (! (res.retrieve && res.retrieve.data)) return cb(new Error("empty result returned from SearchSubtitles"));

			debugLog("subtitles-crawler: found "+res.retrieve.data.length+" subtitle submissions for "+query.hash+" / "+query.tag);
			pickSubtitles(query, res.retrieve.data, subtitles);
			cb();
		}],
		do_grouping: ["pick", function(cb, res) {
			if (GROUPING_DISABLED) return process.nextTick(cb);

			var priority_picks = subtitles.yify_picks.concat(subtitles.moviehash_picks).slice(0, SUBTITLES_FOR_GROUPING);
			var toGroup = [];
			cb = _.once(cb);

			_.each(subtitles.subtitles, function(group) {
				group.forEach(function(s) { if (priority_picks.indexOf(s.id)>-1) toGroup.push({ id: s.id, uri: s.url }) });
			});

			debugLog("subtitles-crawler: started grouping for "+query.hash);
			
			var start = Date.now(); // TEMP
			subGrouping(toGroup, function(err, groups) {
				if (err) console.error(err);
				if (groups && groups[0]) {
					subtitles.grouping_map = subGroupingAverage(_.pluck(groups[0],"heatmap"));
					subtitles.grouping_threshold = groups.threshold;
					subtitles.markModified("grouping_map");
					subtitles.save();
					debugLog("subtitles-crawler: grouping for "+query.hash+" took "+(Date.now()-start)+"ms");
				}
				cb();
			}, { sensitivity: SUB_GROUPING_SENSITIVITY });

			// set a max time on the grouping
			setTimeout(cb, GROUPING_MAX_TIME); 
		}]        
	}, function(err) {
		if (err && err!==true) { console.error("findSubtitles", err); return callback(null, subtitles) };

		if (err === true) {
			debugLog("subtitles-crawler: subtitles for "+query.hash+" are fresh, not scraped");
		}

		callback(null, subtitles);
	});
};

module.exports = findSubtitles;
