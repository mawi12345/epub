var xml2js = require('xml2js');
var xml2jsOptions = xml2js.defaults['0.1'];
var util = require('util');
var EventEmitter = require('events').EventEmitter;

try {
    // zipfile is an optional dependency:
    var ZipFile = require("zipfile").ZipFile;
} catch (err) {
    // Mock zipfile using pure-JS adm-zip:
    var AdmZip = require('adm-zip');
    
    var ZipFile = function(filename) {
        this.admZip = new AdmZip(filename);
        this.names = this.admZip.getEntries().map(function(zipEntry) {
            return zipEntry.entryName;
        });
        this.count = this.names.length;
    };
    ZipFile.prototype.readFile = function(name, cb) {
        this.admZip.readFileAsync(this.admZip.getEntry(name), function(buffer, error) {
            // `error` is bogus right now, so let's just drop it.
            // see https://github.com/cthackers/adm-zip/pull/88
            return cb(null, buffer);
        });
    };
}


//TODO: Cache parsed data

/**
 *  new EPubError(message, [cause])
 *  - message (String): the error message
 *  - cause (Error): the wrapped error
 *
 */
function EPubError(message, cause) {
    Error.call(this);
    Error.captureStackTrace(this, this.constructor);
    this.name = 'EPubError';
    this.message = message;
    this.cause = cause;
}
util.inherits(EPubError, Error);

EPubError.prototype.toString = function () {
    if (this.cause) {
        return "EPubError: " + this.message + ", " + this.cause.toString();
    } else {
        return "EPubError: " + this.message;
    }
};

/**
 *  new EPub(fname[, imageroot][, linkroot])
 *  - fname (String): filename for the ebook
 *  - imageroot (String): URL prefix for images
 *  - linkroot (String): URL prefix for links
 *
 *  Creates an Event Emitter type object for parsing epub files
 *
 *      var epub = new EPub("book.epub");
 *      epub.on("end", function () {
 *           console.log(epub.spine);
 *      });
 *      epub.on("error", function (error) { ... });
 *      epub.parse();
 *
 *  Image and link URL format is:
 *
 *      imageroot + img_id + img_zip_path
 *
 *  So an image "logo.jpg" which resides in "OPT/" in the zip archive
 *  and is listed in the manifest with id "logo_img" will have the
 *  following url (providing that imageroot is "/images/"):
 *
 *      /images/logo_img/OPT/logo.jpg
 **/
function EPub(fname, imageroot, linkroot) {
    EventEmitter.call(this);
    this.filename = fname;

    this.imageroot = (imageroot || "/images/").trim();
    this.linkroot = (linkroot || "/links/").trim();

    if (this.imageroot.substr(-1) != "/") {
        this.imageroot += "/";
    }
    if (this.linkroot.substr(-1) != "/") {
        this.linkroot += "/";
    }
}
util.inherits(EPub, EventEmitter);

/**
 *  EPub#parse() -> undefined
 *
 *  Starts the parser, needs to be called by the script
 **/
EPub.prototype.parse = function (callback) {

    //this.containerFile = false;
    //this.mimeFile = false;

    /*
    this.rootFile = false;
    this.metadata = {};
    this.manifest = {};
    this.spine    = {toc: false, contents: []};
    this.flow = [];
    this.toc = [];
    */

    this.open((function(err){
        if (err) {
            if (callback instanceof Function) {
                callback(err);
            } else {
                this.emit("error", err);
            }
        } else {
            this.getMimeType((function(err, mime){
                if (err) {
                    if (callback instanceof Function) {
                        callback(err);
                    } else {
                        this.emit("error", err);
                    }
                } else {
                    if (mime != "application/epub+zip") {
                        var err = new EPubError("Unsupported mime type "+mime);
                        if (callback instanceof Function) {
                            callback(err);
                        } else {
                            this.emit("error", err);
                        }
                    } else {
                        this.getRootFiles((function(err, rootfiles) {
                            if (err) {
                                if (callback instanceof Function) {
                                    callback(err);
                                } else {
                                    this.emit("error", err);
                                }
                            } else {
                                this.parseRootFile(rootfiles[0], (function(err, res){
                                    if (err) {
                                        this.emit("error", err);
                                    } else {
                                        this.rootFile = rootfiles[0];
                                        this.metadata = res.metadata || {};
                                        this.manifest = res.manifest || {};
                                        this.spine = res.spine || {toc: false, contents: []};
                                        this.flow = res.flow || [];
                                        this.toc = res.toc || [];
                                        this.emit("end");
                                        if (callback instanceof Function) {
                                            callback(null, res);
                                        }
                                    }
                                }).bind(this)); // end parse rootfile
                            }
                        }).bind(this)); // end rootfiles
                    }
                }
            }).bind(this)); // end mimetype
        }
    }).bind(this)); // end open
};

/**
 *  EPub#open() -> undefined
 *
 *  Opens the epub file with Zip unpacker, retrieves file listing
 *  and runs mime type check
 **/
EPub.prototype.open = function (callback) {
    if (!(callback instanceof Function)) {
        throw new EPubError("open requires a callback as first parameter");
    }

    try {
        this.zip = new ZipFile(this.filename);
    } catch (err) {
        callback(new EPubError("Invalid/missing file", err))
        return;
    }

    if (!this.zip.names || !this.zip.names.length) {
        callback(new EPubError("No files in archive"));
    } else {
        callback(null);
    }
};

/**
 *  EPub#getMimeType(function(err, mime)) -> undefined
 *
 *  Checks if there's a file called "mimetype" and returns the
 *  utf-8 decoded content of the file.
 **/
EPub.prototype.getMimeType = function (callback) {
    if (!(callback instanceof Function)) {
        throw new EPubError("getMimeType requires a callback as first parameter");
    }

    var i, len, mimeFile;

    for (i = 0, len = this.zip.names.length; i < len; i++) {
        if (this.zip.names[i].toLowerCase() == "mimetype") {
            mimeFile = this.zip.names[i];
            break;
        }
    }
    if (!mimeFile) {
        callback(new EPubError("No mimetype file in archive"));
    } else {
        this.zip.readFile(mimeFile, (function (err, data) {
            if (err) {
                callback(new EPubError("Reading archive mimetype failed", err));
            } else {
                var mime = data.toString("utf-8").toLowerCase().trim();
                callback(null, mime);
            }
        }).bind(this));
    }
};

/**
 *  EPub#getRootFiles(function(err, rootfiles)) -> undefined
 *
 *  Looks for a "meta-inf/container.xml" file and searches for a
 *  rootfile element with mime type "application/oebps-package+xml".
 *  On success calls the callback with rootfiles array.
 **/
EPub.prototype.getRootFiles = function (callback) {
    if (!(callback instanceof Function)) {
        throw new EPubError("getRootFiles requires a callback as first parameter");
    }

    var containerFile;
    for (var i = 0; i < this.zip.names.length; i++) {
        if (this.zip.names[i].toLowerCase() == "meta-inf/container.xml") {
            containerFile = this.zip.names[i];
            break;
        }
    }
    if (!containerFile) {
        callback(new EPubError("No container file in archive"));
    } else {
        this.zip.readFile(containerFile, (function (err, data) {
            if (err) {
                callback(new EPubError("Reading archive container failed", err));
            } else {
                var xml = data.toString("utf-8").toLowerCase().trim(),
                    xmlparser = new xml2js.Parser(xml2jsOptions);

                // http://www.idpf.org/epub/30/spec/epub30-ocf.html#sec-container-metainf
                xmlparser.on("end", (function (result) {
                    if (!result.rootfiles || !result.rootfiles.rootfile) {
                        this.emit("error", new EPubError("No rootfiles found"));
                        console.dir(result);
                        return;
                    }

                    var rootfile = result.rootfiles.rootfile,
                        filenames = [];

                    if (Array.isArray(rootfile)) {
                        for (var i = 0; i < rootfile.length; i++) {
                            if (rootfile[i]["@"]["media-type"] &&
                                    rootfile[i]["@"]["media-type"] == "application/oebps-package+xml" &&
                                    rootfile[i]["@"]["full-path"]) {
                                filenames.push(rootfile[i]["@"]["full-path"].trim());
                            }
                        }
                    } else if (rootfile["@"]) {
                        if (rootfile["@"]["media-type"]  !=  "application/oebps-package+xml" || !rootfile["@"]["full-path"]) {
                            callback(new EPubError("Rootfile in unknown format"));
                        } else {
                            filenames.push(rootfile["@"]["full-path"].trim());
                        }
                    }

                    if (filenames.length <= 0) {
                        callback(new EPubError("Empty rootfile"));
                    } else {
                        var validfiles = [];
                        for (var x = 0; x < filenames.length; x++) {
                            for (var i = 0; i < this.zip.names.length; i++) {
                                if (this.zip.names[i] == filenames[x]) {
                                    validfiles.push(filenames[x]);
                                }
                            }
                        }

                        if (validfiles.length <= 0) {
                            callback(new EPubError("Rootfile not found from archive"));
                        } else {
                            callback(null, validfiles);
                        }
                    }
                }).bind(this));

                xmlparser.on("error", function (err) {
                    callback(new EPubError("Parsing container XML failed", err));
                });

                xmlparser.parseString(xml);
            }
        }).bind(this));
    }
};

/**
 *  EPub#parseRootFile(rootfile, function(err, data)) -> undefined
 *
 *  Parses the rootfile XML and calls rootfile parser
 **/
EPub.prototype.parseRootFile = function (rootFile, callback) {

    this.zip.readFile(rootFile, (function (err, data) {
        if (err) {
            callback(new EPubError("Reading archive failed", err));
        } else {
            var xml = data.toString("utf-8"),
                xmlparser = new xml2js.Parser(xml2jsOptions);

            xmlparser.on("end", (function (content) {
                var res = {};
                res.version = content['@'].version || '2.0';

                keys = Object.keys(content);
                var map = {};
                for (var i = 0; i < keys.length; i++) {
                    var key = (keys[i].split(":").pop() || "").toLowerCase().trim();
                    map[key] = content[keys[i]];
                }

                var path = rootFile.split("/");
                path.pop();

                if (map.metadata) {
                    res.metadata = this.parseMetadata(map.metadata);
                }

                if (map.manifest) {
                    res.manifest = this.parseManifest(map.manifest, path);
                }

                if (map.spine && res.manifest) {
                    res.spine = this.parseSpine(map.spine, res.manifest, path);
                    if (res.spine.contents) {
                        res.flow = res.spine.contents;
                    }
                }
                /*
                if (map.guide) {
                    res.guide = this.parseGuide(map.guide);
                }
                */

                if (res.manifest && res.spine && res.spine.toc) {
                    this.parseTOC(res.spine, res.manifest, function(err, toc) {
                        if (err) {
                            callback(err);
                        } else {
                            res.toc = toc;
                            callback(null, res);
                        }
                    });
                } else {
                    callback(null, res);
                }
            }).bind(this));

            xmlparser.on("error", function (err) {
                callback(new EPubError("Parsing container XML failed", err));
            });

            xmlparser.parseString(xml);
        }
    }).bind(this));
};

/**
 *  EPub#parseMetadata() -> undefined
 *
 *  Parses "metadata" block (book metadata, title, author etc.)
 **/
EPub.prototype.parseMetadata = function (metadata) {
    var i, j, len, keys, keyparts, key;
    var res = {};
    keys = Object.keys(metadata);
    for (i = 0, len = keys.length; i < len; i++) {
        keyparts = keys[i].split(":");
        key = (keyparts.pop() || "").toLowerCase().trim();
        switch (key) {
        case "publisher":
            if (Array.isArray(metadata[keys[i]])) {
                res.publisher = String(metadata[keys[i]][0] && metadata[keys[i]][0]["#"] || metadata[keys[i]][0] || "").trim();
            } else {
                res.publisher = String(metadata[keys[i]]["#"] || metadata[keys[i]] || "").trim();
            }
            break;
        case "language":
            if (Array.isArray(metadata[keys[i]])) {
                res.language = String(metadata[keys[i]][0] && metadata[keys[i]][0]["#"] || metadata[keys[i]][0] || "").toLowerCase().trim();
            } else {
                res.language = String(metadata[keys[i]]["#"] || metadata[keys[i]] || "").toLowerCase().trim();
            }
            break;
        case "title":
            if (Array.isArray(metadata[keys[i]])) {
                res.title = String(metadata[keys[i]][0] && metadata[keys[i]][0]["#"] || metadata[keys[i]][0] || "").trim();
            } else {
                res.title = String(metadata[keys[i]]["#"] || metadata[keys[i]] || "").trim();
            }
            break;
        case "subject":
            if (Array.isArray(metadata[keys[i]])) {
                res.subject = String(metadata[keys[i]][0] && metadata[keys[i]][0]["#"] || metadata[keys[i]][0] || "").trim();
            } else {
                res.subject = String(metadata[keys[i]]["#"] || metadata[keys[i]] || "").trim();
            }
            break;
        case "description":
            if (Array.isArray(metadata[keys[i]])) {
                res.description = String(metadata[keys[i]][0] && metadata[keys[i]][0]["#"] || metadata[keys[i]][0] || "").trim();
            } else {
                res.description = String(metadata[keys[i]]["#"] || metadata[keys[i]] || "").trim();
            }
            break;
        case "creator":
            if (Array.isArray(metadata[keys[i]])) {
                res.creator = String(metadata[keys[i]][0] && metadata[keys[i]][0]["#"] || metadata[keys[i]][0] || "").trim();
                res.creatorFileAs = String(metadata[keys[i]][0] && metadata[keys[i]][0]['@'] && metadata[keys[i]][0]['@']["opf:file-as"] || res.creator).trim();
            } else {
                res.creator = String(metadata[keys[i]]["#"] || metadata[keys[i]] || "").trim();
                res.creatorFileAs = String(metadata[keys[i]]['@'] && metadata[keys[i]]['@']["opf:file-as"] || res.creator).trim();
            }
            break;
        case "date":
            if (Array.isArray(metadata[keys[i]])) {
                res.date = String(metadata[keys[i]][0] && metadata[keys[i]][0]["#"] || metadata[keys[i]][0] || "").trim();
            } else {
                res.date = String(metadata[keys[i]]["#"] || metadata[keys[i]] || "").trim();
            }
            break;
        case "identifier":
            if (metadata[keys[i]]["@"] && metadata[keys[i]]["@"]["opf:scheme"] == "ISBN") {
                res.ISBN = String(metadata[keys[i]]["#"] || "").trim();
            } else if (metadata[keys[i]]["@"] && metadata[keys[i]]["@"].id && metadata[keys[i]]["@"].id.match(/uuid/i)) {
                res.UUID = String(metadata[keys[i]]["#"] || "").replace('urn:uuid:', '').toUpperCase().trim();
            } else if (Array.isArray(metadata[keys[i]])) {
                for (j = 0; j < metadata[keys[i]].length; j++) {
                    if (metadata[keys[i]][j]["@"]) {
                        if (metadata[keys[i]][j]["@"]["opf:scheme"] == "ISBN") {
                            res.ISBN = String(metadata[keys[i]][j]["#"] || "").trim();
                        } else if (metadata[keys[i]][j]["@"].id && metadata[keys[i]][j]["@"].id.match(/uuid/i)) {
                            res.UUID = String(metadata[keys[i]][j]["#"] || "").replace('urn:uuid:', '').toUpperCase().trim();
                        }
                    }
                }
            }
            break;
        }
    }
    
    var metas = metadata['meta'] || {};
    Object.keys(metas).forEach(function(key) {
        var meta = metas[key];
        if (meta['@'] && meta['@'].name) {
            var name = meta['@'].name;
            res[name] = meta['@'].content;
        }
        if (meta['#'] && meta['@'].property) {
            res[meta['@'].property] = meta['#'];
        }
    }, this);
    return res;
};

/**
 *  EPub#parseManifest() -> undefined
 *
 *  Parses "manifest" block (all items included, html files, images, styles)
 **/
EPub.prototype.parseManifest = function (manifest, path) {
    var i, len, element, path_str;
    var res = {};
    path_str = path.join("/");

    if (manifest.item) {
        for (i = 0, len = manifest.item.length; i < len; i++) {
            if (manifest.item[i]['@']) {
                element = manifest.item[i]['@'];

                if (element.href && element.href.substr(0, path_str.length)  !=  path_str) {
                    element.href = path.concat([element.href]).join("/");
                }

                res[manifest.item[i]['@'].id] = element;

            }
        }
    }
    return res;
};

/**
 *  EPub#parseSpine() -> undefined
 *
 *  Parses "spine" block (all html elements that are shown to the reader)
 **/
EPub.prototype.parseSpine = function (spine, manifest, path) {
    var i, len, element;
    var res = {toc: false, contents: []};

    if (spine['@'] && spine['@'].toc) {
        res.toc = manifest[spine['@'].toc] || false;
    }

    if (spine.itemref) {
        if(!Array.isArray(spine.itemref)){
            spine.itemref = [spine.itemref];
        }
        for (i = 0, len = spine.itemref.length; i < len; i++) {
            if (spine.itemref[i]['@']) {
                if (element = manifest[spine.itemref[i]['@'].idref]) {
                    res.contents.push(element);
                }
            }
        }
    }
    return res;
};

/**
 *  EPub#parseTOC() -> undefined
 *
 *  Parses ncx file for table of contents (title, html file)
 **/
EPub.prototype.parseTOC = function (spine, manifest, callback) {
    var i, len, path = spine.toc.href.split("/"), id_list = {}, keys;
    path.pop();

    keys = Object.keys(manifest);
    for (i = 0, len = keys.length; i < len; i++) {
        id_list[manifest[keys[i]].href] = keys[i];
    }

    this.zip.readFile(spine.toc.href, (function (err, data) {
        if (err) {
            callback(new EPubError("Reading archive failed", err));
        } else {
            var xml = data.toString("utf-8"),
                xmlparser = new xml2js.Parser(xml2jsOptions);

            xmlparser.on("end", (function (result) {
                if (result.navMap && result.navMap.navPoint) {
                    callback(null, this.walkNavMap(result.navMap.navPoint, path, id_list));
                } else {
                    callback(null);
                }
            }).bind(this));

            xmlparser.on("error", function (err) {
                callback(new EPubError("Parsing container XML failed", err));
            });

            xmlparser.parseString(xml);
        }
    }).bind(this));
};

/**
 *  EPub#walkNavMap(branch, path, id_list,[, level]) -> Array
 *  - branch (Array | Object): NCX NavPoint object
 *  - path (Array): Base path
 *  - id_list (Object): map of file paths and id values
 *  - level (Number): deepness
 *
 *  Walks the NavMap object through all levels and finds elements
 *  for TOC
 **/
EPub.prototype.walkNavMap = function (branch, path, id_list, level) {
    level = level || 0;

    // don't go too far
    if (level > 7) {
        return [];
    }

    var output = [];

    if (!Array.isArray(branch)) {
        branch = [branch];
    }

    for (var i = 0; i < branch.length; i++) {
        if (branch[i].navLabel) {

            var title = '';
            if (branch[i].navLabel && typeof branch[i].navLabel.text == 'string') {
                title = branch[i].navLabel.text.trim();
            }
            var order = Number(branch[i]["@"] && branch[i]["@"].playOrder || 0);
            if (isNaN(order)) {
                order = 0;
            }
            var href = '';
            if (branch[i].content && branch[i].content["@"] && typeof branch[i].content["@"].src == 'string') {
                href = branch[i].content["@"].src.trim();
            }

            var element = {
                level: level,
                order: order,
                title: title
            };

            if (href) {
                href = path.concat([href]).join("/");
                element.href = href;

                if (id_list[element.href]) {
                    // link existing object
                    element = this.manifest[id_list[element.href]];
                    element.title = title;
                    element.order = order;
                    element.level = level;
                } else {
                    // use new one
                    element.href = href;
                    element.id =  (branch[i]["@"] && branch[i]["@"].id || "").trim();
                }

                output.push(element);
            }
        }
        if (branch[i].navPoint) {
            output = output.concat(this.walkNavMap(branch[i].navPoint, path, id_list, level + 1));
        }
    }
    return output;
};

/**
 *  EPub#getChapter(id, callback) -> undefined
 *  - id (String): Manifest id value for a chapter
 *  - callback (Function): callback function
 *
 *  Finds a chapter text for an id. Replaces image and link URL's, removes
 *  <head> etc. elements. Return only chapters with mime type application/xhtml+xml
 **/
EPub.prototype.getChapter = function (id, callback) {
    this.getChapterRaw(id, (function (err, str) {
        if (err) {
            callback(err);
            return;
        }

        var i, len, path = this.rootFile.split("/"), keys = Object.keys(this.manifest);
        path.pop();

        // remove linebreaks (no multi line matches in JS regex!)
        str = str.replace(/\r?\n/g, "\u0000");

        // keep only <body> contents
        str.replace(/<body[^>]*?>(.*)<\/body[^>]*?>/i, function (o, d) {
            str = d.trim();
        });

        // remove <script> blocks if any
        str = str.replace(/<script[^>]*?>(.*?)<\/script[^>]*?>/ig, function (o, s) {
            return "";
        });

        // remove <style> blocks if any
        str = str.replace(/<style[^>]*?>(.*?)<\/style[^>]*?>/ig, function (o, s) {
            return "";
        });

        // remove onEvent handlers
        str = str.replace(/(\s)(on\w+)(\s*=\s*["']?[^"'\s>]*?["'\s>])/g, function (o, a, b, c) {
            return a + "skip-" + b + c;
        });

        // replace images
        str = str.replace(/(\ssrc\s*=\s*["']?)([^"'\s>]*?)(["'\s>])/g, (function (o, a, b, c) {
            var img = path.concat([b]).join("/").trim(),
                element;

            for (i = 0, len = keys.length; i < len; i++) {
                if (this.manifest[keys[i]].href == img) {
                    element = this.manifest[keys[i]];
                    break;
                }
            }

            // include only images from manifest
            if (element) {
                return a + this.imageroot + element.id + "/" + img + c;
            } else {
                return "";
            }

        }).bind(this));

        // replace links
        str = str.replace(/(\shref\s*=\s*["']?)([^"'\s>]*?)(["'\s>])/g, (function (o, a, b, c) {
            var linkparts = b && b.split("#"),
                link = path.concat([(linkparts.shift() || "")]).join("/").trim(),
                element;

            for (i = 0, len = keys.length; i < len; i++) {
                if (this.manifest[keys[i]].href.split("#")[0] == link) {
                    element = this.manifest[keys[i]];
                    break;
                }
            }

            if (linkparts.length) {
                link  +=  "#" + linkparts.join("#");
            }

            // include only images from manifest
            if (element) {
                return a + this.linkroot + element.id + "/" + link + c;
            } else {
                return a + b + c;
            }

        }).bind(this));

        // bring back linebreaks
        str = str.replace(/\u0000/g, "\n").trim();

        callback(null, str);
    }).bind(this));
};


/**
 *  EPub#getChapterRaw(id, callback) -> undefined
 *  - id (String): Manifest id value for a chapter
 *  - callback (Function): callback function
 *
 *  Returns the raw chapter text for an id.
 **/
EPub.prototype.getChapterRaw = function (id, callback) {
    if (this.manifest[id]) {

        if (!(this.manifest[id]['media-type'] == "application/xhtml+xml" || this.manifest[id]['media-type'] == "image/svg+xml")) {
            return callback(new EPubError("Invalid mime type for chapter"));
        }

        this.zip.readFile(this.manifest[id].href, (function (err, data) {
            if (err) {
                callback(new EPubError("Reading archive failed"));
                return;
            }

            var str = data.toString("utf-8");

            callback(null, str);

        }).bind(this));
    } else {
        callback(new EPubError("File not found"));
    }
};


/**
 *  EPub#getImage(id, callback) -> undefined
 *  - id (String): Manifest id value for an image
 *  - callback (Function): callback function
 *
 *  Finds an image for an id. Returns the image as Buffer. Callback gets
 *  an error object, image buffer and image content-type.
 *  Return only images with mime type image
 **/
EPub.prototype.getImage = function (id, callback) {
    if (this.manifest[id]) {

        if ((this.manifest[id]['media-type'] || "").toLowerCase().trim().substr(0, 6)  !=  "image/") {
            return callback(new EPubError("Invalid mime type for image"));
        }

        this.getFile(id, callback);
    } else {
        callback(new EPubError("File not found"));
    }
};


/**
 *  EPub#getFile(id, callback) -> undefined
 *  - id (String): Manifest id value for a file
 *  - callback (Function): callback function
 *
 *  Finds a file for an id. Returns the file as Buffer. Callback gets
 *  an error object, file contents buffer and file content-type.
 **/
EPub.prototype.getFile = function (id, callback) {
    if (this.manifest[id]) {

        this.zip.readFile(this.manifest[id].href, (function (err, data) {
            if (err) {
                callback(new EPubError("Reading archive failed"));
                return;
            }

            callback(null, data, this.manifest[id]['media-type']);
        }).bind(this));
    } else {
        callback(new EPubError("File not found"));
    }
};


EPub.prototype.readFile = function(filename, options, callback_) {
    var callback = arguments[arguments.length - 1];
    
    if (util.isFunction(options) || !options) {
        this.zip.readFile(filename, callback);
    } else if (util.isString(options)) {
        // options is an encoding
        this.zip.readFile(filename, function(err, data) {
            if (err) {
                callback(new EPubError('Reading archive failed'));
                return;
            }
            callback(null, data.toString(options));
        });
    } else {
        throw new TypeError('Bad arguments');
    }
};


// Expose to the world
module.exports = EPub;