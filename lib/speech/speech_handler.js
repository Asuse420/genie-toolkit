// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Genie
//
// Copyright 2020 The Board of Trustees of the Leland Stanford Junior University
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
"use strict";

const events = require('events');

const SpeechRecognizer = require('./speech_recognizer');
const SpeechSynthesizer = require('./speech_synthesizer');
const { MessageType } = require('../dialogue-agent/protocol');

module.exports = class SpeechHandler extends events.EventEmitter {
    constructor(conversation, platform, options = {}) {
        super();
        this._platform = platform;

        this._conversation = conversation;

        this._pulse = platform.getCapability('sound');
        this._wakeWordDetector = platform.getCapability('wakeword-detector');
        this._systemLock = platform.getCapability('system-lock');

        this._recognizer = new SpeechRecognizer({
            locale: this._platform.locale,
            subscriptionKey: options.subscriptionKey
        });
        this._recognizer.on('error', (e) => {
            this.emit('error', e);
        });
        this._tts = new SpeechSynthesizer(platform);

        this._currentRequest = null;

        this._started = true;
        this._enableVoiceInput = true;
        this._enableVoiceOutput = true;
    }

    setVoiceInput(enable) {
        if (enable === this._enableVoiceInput)
            return;
        this._enableVoiceInput = enable;
        if (this._started && enable)
            this._startVoiceInput();
        else
            this._stopVoiceInput();
    }

    setVoiceOutput(enable) {
        if (enable === this._enableVoiceOutput)
            return;
        this._enableVoiceOutput = enable;
        if (!enable)
            this._tts.clearQueue();
    }

    // called from conversation
    setHypothesis() {
        // ignore, this is called from the conversation when it broadcasts the hypothesis
        // to all listeners
    }
    setExpected(expect) {
    }

    async addMessage(message) {
        switch (message.type) {
        case MessageType.COMMAND:
            await this._tts.clearQueue();
            break;

        case MessageType.TEXT:
        case MessageType.RESULT:
            if (!this._enableVoiceOutput)
                break;
            await this._tts.say(message.text);
            break;

        case MessageType.RDL:
            if (!this._enableVoiceOutput)
                break;
            await this._speechSynth.say(message.rdl.displayTitle);
            break;

        // ignore all other message types
        }
    }

    /**
     * Programmatically trigger a wakeword.
     *
     * This can be used to emulate a wakeword with a push button.
     */
    wakeword() {
        this.emit('wakeword');
        this._onDetected();
    }

    _onDetected() {
        // if we already have a request active, ignore the wakeword, we're
        // already streaming the sound to the server
        if (this._currentRequest)
            return;

        this._currentRequest = this._recognizer.request(this._stream);
        this._currentRequest.on('hypothesis', (hypothesis) => {
            this._conversation.setHypothesis(hypothesis);
        });
        this._currentRequest.on('done', (status, utterance) => {
            this._currentRequest = null;
            if (status === 'Success') {
                console.log('Recognized as "' + utterance + '"');
                this._conversation.setHypothesis('');
                this._conversation.handleCommand(utterance);
            } else if (status === 'NoMatch') {
                this.emit('no-match');
            } else if (status === 'InitialSilenceTimeout') {
                this.emit('silence');
            } else {
                console.log('Recognition error: ' + status);
            }
        });
        this._currentRequest.on('error', (error) => {
            this._currentRequest = null;
            this._onError(error);
        });
    }

    _onError(error) {
        console.log('Error in speech recognition: ' + error.message);
        this._tts.say("Sorry, I had an error understanding your speech: " + error.message);
    }

    start() {
        this._conversation.addOutput(this, false);
        this._started = true;

        if (this._enableVoiceInput)
            this._startVoiceInput();
    }

    _startVoiceInput() {
        this._stream = this._pulse.createRecordStream({
            format: 'S16LE',
            rate: 16000,
            channels: 1,
            stream: 'genie-voice-output',
            properties: {
                'media.role': 'voice-assistant',
                'filter.want': 'echo-cancel',
            }
        });

        this._stream.on('state', (state) => {
            console.log('Record stream is now ' + state);
            if (state === 'ready')
                this.emit('ready');
        });

        if (this._wakeWordDetector) {
            this._wakeWordDetector.on('wakeword', (wakeword) => {
                if (this._systemLock && this._systemLock.isActive) {
                    console.log('Ignored wakeword ' + wakeword + ' because the system is locked');
                    return;
                }

                console.log('Wakeword ' + wakeword + ' detected');
                this.emit('wakeword', wakeword);
                this._onDetected();
            });
            this._stream.pipe(this._wakeWordDetector);
        }
    }

    stop() {
        this._conversation.removeOutput(this);
        this._started = false;
        this._stopVoiceInput();
        this._tts.clearQueue();
    }

    _stopVoiceInput() {
        if (!this._stream)
            return;
        this._stream.end();
        this._stream = null;
        this._recognizer.close();
        if (this._wakeWordDetector)
            this._wakeWordDetector.destroy();
    }
};
