// -*- mode: typescript; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Genie
//
// Copyright 2019-2020 The Board of Trustees of the Leland Stanford Junior University
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

import * as argparse from 'argparse';
import * as Tp from 'thingpedia';
import Stream from 'stream';
import * as fs from 'fs';

import * as TargetLanguages from '../lib/languages';
import {
    DatasetStringifier,
    DialogueParser,
    DialogueTurn,
    ParsedDialogue
} from '../lib/dataset-tools/parsers';
import * as StreamUtils from '../lib/utils/stream-utils';
import * as Utils from '../lib/utils/misc-utils';
import { EntityMap } from '../lib/utils/entity-utils';
import * as I18n from '../lib/i18n';

import ProgressBar from './lib/progress_bar';
import { maybeCreateReadStream, readAllLines } from './lib/argutils';

interface DialogueToTurnStreamOptions {
    locale : string;
    debug : boolean;
    side : string;
    flags : string;
    idPrefix : string;
    targetLanguage : string;
    deduplicate : boolean;
    tokenized : boolean;
    thingpediaClient : Tp.BaseClient;
}

class DialogueToTurnStream extends Stream.Transform {
    private _locale : string;
    private _options : DialogueToTurnStreamOptions;
    private _side : string;
    private _flags : string;
    private _idPrefix : string;
    private _target : TargetLanguages.TargetLanguage;
    private _dedupe : Set<string>|undefined;
    private _tokenized : boolean;
    private _tokenizer : I18n.BaseTokenizer|null;

    constructor(options : DialogueToTurnStreamOptions) {
        super({ objectMode: true });

        this._locale = options.locale;

        this._options = options;
        this._side = options.side;
        this._flags = options.flags;
        this._idPrefix = options.idPrefix;
        this._target = TargetLanguages.get(options.targetLanguage);
        this._dedupe = options.deduplicate ? new Set : undefined;

        this._tokenized = options.tokenized;
        this._tokenizer = null;
        if (!this._tokenized)
            this._tokenizer = I18n.get(this._locale).getTokenizer();
    }

    private _preprocess(sentence : string, contextEntities : EntityMap) {
        let tokenized;
        if (this._tokenized) {
            const tokens = sentence.split(' ');
            const entities = Utils.makeDummyEntities(sentence);
            tokenized = { tokens, entities };
        } else {
            tokenized = this._tokenizer!.tokenize(sentence);
        }
        Utils.renumberEntities(tokenized, contextEntities);
        return tokenized;
    }

    private _getDedupeKey(context : string[], utterance : string[]) {
        return context.join(' ') + '<sep>' + utterance.join(' ');
    }

    private async _emitAgentTurn(i : number, turn : DialogueTurn, dlg : ParsedDialogue) {
        if (i === 0)
            return;

        const context = await this._target.parse(turn.context!, this._options) as any;
        const agentContext = this._target.prepareContextForPrediction(context, 'agent') as any;
        const [contextCode, contextEntities] = this._target.serializeNormalized(agentContext);

        const agentTarget = await this._target.parse(turn.agent_target!, this._options) as any;
        const agentCode = await this._target.serializePrediction(agentTarget, [''], contextEntities, 'agent', {
            locale: this._locale
        });

        const { tokens, } = this._preprocess(turn.agent!, contextEntities);

        if (this._dedupe) {
            const key = this._getDedupeKey(contextCode, tokens);
            if (this._dedupe.has(key))
                return;
            this._dedupe.add(key);
        }

        this.push({
            id: this._flags + '' + this._idPrefix + dlg.id + '/' + i,
            context: contextCode.join(' '),
            preprocessed: tokens.join(' '),
            target_code: agentCode.join(' ')
        });
    }

    private async _emitUserTurn(i : number, turn : DialogueTurn, dlg : ParsedDialogue) {
        let context, contextCode, contextEntities;
        if (i > 0) {
            // if we have an "intermediate context" (C: block after AT:) we ran the execution
            // after the agent spoke, so we don't need to apply the agent turn any more
            //
            // (this occurs only when annotating multiwoz data, when the agent chooses to complete
            // an action with incomplete information, choosing the value spontaneously)
            if (turn.intermediate_context) {
                context = await this._target.parse(turn.intermediate_context, this._options) as any;
            } else {
                context = await this._target.parse(turn.context!, this._options) as any;
                // apply the agent prediction to the context to get the state of the dialogue before
                // the user speaks
                const agentPrediction = await this._target.parse(turn.agent_target!, this._options) as any;
                context = this._target.computeNewState(context, agentPrediction, 'agent');
            }

            const userContext = this._target.prepareContextForPrediction(context, 'user') as any;
            [contextCode, contextEntities] = this._target.serializeNormalized(userContext);
        } else {
            context = null;
            contextCode = ['null'];
            contextEntities = {};
        }

        const { tokens, entities } = this._preprocess(turn.user, contextEntities);
        const userTarget = await this._target.parse(turn.user_target, this._options) as any;
        const code = await this._target.serializePrediction(userTarget, tokens, entities, 'user', {
            locale: this._locale
        });

        if (this._dedupe) {
            const key = this._getDedupeKey(contextCode, tokens);
            if (this._dedupe.has(key))
                return;
            this._dedupe.add(key);
        }

        this.push({
            id: this._flags + '' + this._idPrefix + dlg.id + '/' + i,
            context: contextCode.join(' '),
            preprocessed: tokens.join(' '),
            target_code: code.join(' ')
        });
    }

    private async _doTransform(dlg : ParsedDialogue) {
        for (let i = 0; i < dlg.length; i++) {
            const turn = dlg[i];

            try {
                if (this._side === 'agent')
                    await this._emitAgentTurn(i, turn, dlg);
                else
                    await this._emitUserTurn(i, turn, dlg);
            } catch(e) {
                console.error('Failed in dialogue ' + dlg.id);
                console.error(turn);
                throw e;
            }
        }

    }

    _transform(dialog : ParsedDialogue, encoding : BufferEncoding, callback : (err ?: Error|null) => void) {
        this._doTransform(dialog).then(() => callback(null), callback);
    }

    _flush(callback : () => void) {
        process.nextTick(callback);
    }
}

export function initArgparse(subparsers : argparse.SubParser) {
    const parser = subparsers.add_parser('dialog-to-contextual', {
        add_help: true,
        description: "Transform a dialog input file into a contextual dataset (turn by turn)."
    });
    parser.add_argument('-o', '--output', {
        required: true,
        type: fs.createWriteStream
    });
    parser.add_argument('-l', '--locale', {
        required: false,
        default: 'en-US',
        help: `BGP 47 locale tag of the language to evaluate (defaults to 'en-US', English)`
    });
    parser.add_argument('--tokenized', {
        action: 'store_true',
        default: true,
        help: "The dataset is already tokenized (this is the default)."
    });
    parser.add_argument('--no-tokenized', {
        dest: 'tokenized',
        action: 'store_false',
        help: "The dataset is not already tokenized."
    });
    parser.add_argument('--thingpedia', {
        required: true,
        help: 'Path to ThingTalk file containing class definitions.'
    });
    parser.add_argument('-t', '--target-language', {
        required: false,
        default: 'thingtalk',
        choices: TargetLanguages.AVAILABLE_LANGUAGES,
        help: `The programming language to generate`
    });
    parser.add_argument('--side', {
        required: true,
        choices: ['user', 'agent'],
        help: 'Which side of the conversation should be extracted.'
    });
    parser.add_argument('--flags', {
        required: false,
        default: '',
        help: 'Additional flags to add to the generated training examples.'
    });
    parser.add_argument('--id-prefix', {
        required: false,
        default: '',
        help: 'Prefix to add to all sentence IDs (useful to combine multiple datasets).'
    });
    parser.add_argument('--deduplicate', {
        action: 'store_true',
        default: false,
        help: 'Do not output duplicate turns (with the same preprocessed context and utterance)'
    });
    parser.add_argument('--no-deduplicate', {
        action: 'store_false',
        dest: 'deduplicate',
        help: 'Output duplicate turns (with the same preprocessed context and utterance)'
    });
    parser.add_argument('input_file', {
        nargs: '+',
        type: maybeCreateReadStream,
        help: 'Input dialog file; use - for standard input'
    });
    parser.add_argument('--debug', {
        action: 'store_true',
        help: 'Enable debugging.',
        default: true
    });
    parser.add_argument('--no-debug', {
        action: 'store_false',
        dest: 'debug',
        help: 'Disable debugging.',
    });
}

export async function execute(args : any) {
    let tpClient : Tp.FileClient|null = null;
    if (args.thingpedia)
        tpClient = new Tp.FileClient(args);

    const counter = new StreamUtils.CountStream();

    readAllLines(args.input_file, '====')
        .pipe(new DialogueParser())
        .pipe(counter)
        .pipe(new DialogueToTurnStream({
            locale: args.locale,
            targetLanguage: args.target_language,
            thingpediaClient: tpClient!,
            flags: args.flags,
            idPrefix: args.id_prefix,
            side: args.side,
            tokenized: args.tokenized,
            deduplicate: args.deduplicate,
            debug: args.debug
        }))
        .pipe(new DatasetStringifier())
        .pipe(args.output);

    const progbar = new ProgressBar(1);
    counter.on('progress', (value) => {
        //console.log(value);
        progbar.update(value);
    });

    // issue an update now to show the progress bar
    progbar.update(0);

    await StreamUtils.waitFinish(args.output);
}
