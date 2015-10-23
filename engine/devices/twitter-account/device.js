// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2015 Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details

const lang = require('lang');
const Q = require('q');
const Url = require('url');

const Twitter = require('twitter-node-client').Twitter;

const BaseDevice = require('../../base_device');

// encryption ;)
function rot13(x) {
    return Array.prototype.map.call(x, function(ch) {
        var code = ch.charCodeAt(0);
        if (code >= 0x41 && code <= 0x5a)
            code = (((code - 0x41) + 13) % 26) + 0x41;
        else if (code >= 0x61 && code <= 0x7a)
            code = (((code - 0x61) + 13) % 26) + 0x61;

        return String.fromCharCode(code);
    }).join('');
}

const CONSUMER_KEY = process.env['TWITTER_CONSUMER_KEY'] || 'VZRViA2T4qy7CBZjU5juPumZN';
// Twitter uses OAuth 1.0, so this needs to be here...
const CONSUMER_SECRET = process.env['TWITTER_CONSUMER_SECRET'] || rot13('hsTCqM6neIt3hqum6zvnDCIqQkUuyWtSjKBoqZFONvzVXfb7OJ');

// XOR these comments for testing
//var THINGENGINE_ORIGIN = 'http://127.0.0.1:8080';
var THINGENGINE_ORIGIN = 'https://thingengine.stanford.edu';

function makeTwitterApi(accessToken, accessTokenSecret) {
    return new Twitter({
        consumerKey: CONSUMER_KEY,
        consumerSecret: CONSUMER_SECRET,
        callBackUrl: THINGENGINE_ORIGIN + '/devices/oauth2/callback/twitter-account',
        accessToken: accessToken,
        accessTokenSecret: accessTokenSecret
    });
}

const TwitterAccountDevice = new lang.Class({
    Name: 'TwitterAccountDevice',
    Extends: BaseDevice,

    _init: function(engine, state) {
        this.parent(engine, state);

        this.uniqueId = 'twitter-account-' + this.userId;
        this.name = "Twitter Account %s".format(this.screenName);
        this.description = "This is your Twitter Account. You can use it to be updated on the status of your friends, and update them with your thoughts.";
    },

    get screenName() {
        return this.state.screenName;
    },

    get userId() {
        return this.state.userId;
    },

    get accessToken() {
        return this.state.accessToken;
    },

    get accessTokenSecret() {
        return this.state.accessTokenSecret;
    },

    checkAvailable: function() {
        return BaseDevice.Availability.AVAILABLE;
    },

    hasKind: function(kind) {
        switch (kind) {
        case 'online-account':
            return true;
        case 'twitter':
            return true;
        default:
            return this.parent(kind);
        }
    },

    queryInterface: function(iface) {
        switch (iface) {
        case 'twitter':
            return makeTwitterApi(this.accessToken, this.accessTokenSecret);
        default:
            return null;
        }
    },
});

function createDevice(engine, state) {
    return new TwitterAccountDevice(engine, state);
}

function runOAuthStep1() {
    var twitter = makeTwitterApi();

    return Q.Promise(function(callback, errback) {
        return twitter.oauth.getOAuthRequestToken(function(error, oauth_token, oauth_token_secret, query) {
            if (error)
                errback(error);
            else
                callback({ token: oauth_token, tokenSecret: oauth_token_secret, query: query });
        });
    }).then(function(result) {
        var url = Url.parse('https://api.twitter.com/oauth/authorize');
        url.query = result.query;
        url.query['oauth_token'] = result.token;
        url.query['oauth_token_secret'] = result.tokenSecret;
        return [Url.format(url), { 'twitter-token': result.token,
                                   'twitter-token-secret': result.tokenSecret }];
    });
}

function runOAuthStep2(engine, req) {
    var twitter = makeTwitterApi();

    return Q.Promise(function(callback, errback) {
        var token = req.session['twitter-token'];
        var tokenSecret = req.session['twitter-token-secret'];
        var verifier = req.query['oauth_verifier'];

        return twitter.oauth.getOAuthAccessToken(token, tokenSecret, verifier, function(error, oauth_access_token, oauth_access_token_secret, results) {
            if (error)
                errback(error);
            else
                callback({ accessToken: oauth_access_token, accessTokenSecret: oauth_access_token_secret });
        });
    }).then(function(result) {
        twitter = makeTwitterApi(result.accessToken, result.accessTokenSecret);
        return Q.Promise(function(callback, errback) {
            return twitter.getCustomApiCall('/account/verify_credentials.json', {}, errback, callback);
        });
    }).then(function(result) {
        result = JSON.parse(result);
        console.log(result);
        return engine.devices.loadOneDevice({ kind: 'twitter-account',
                                              accessToken: twitter.accessToken,
                                              accessTokenSecret: twitter.accessTokenSecret,
                                              userId: result['id_str'],
                                              screenName: result['screen_name'] }, true);
    });
}

function runOAuth2(engine, req) {
    return Q.try(function() {
        if (req === null) {
            return runOAuthStep1();
        } else {
            return runOAuthStep2(engine, req);
        }
    }).catch(function(e) {
        console.log(e);
        console.log(e.stack);
        throw e;
    });
}

module.exports.createDevice = createDevice;
module.exports.runOAuth2 = runOAuth2;
