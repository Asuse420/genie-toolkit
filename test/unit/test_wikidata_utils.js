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
// Author: Silei Xu <silei@cs.stanford.edu>
"use strict";

const assert = require('assert');

const {
    getPropertyLabel,
    getPropertyList,
    getExampleValuesForProperty
} = require('../../tool/autoqa/wikidata/utils');

const TEST_CASES_PROPERTY_LABELS = [
    ['P31', 'instance of'],
    ['P569', 'date of birth']
];

const TEST_CASES_PROPERTY_LIST = [
    ['Q5', ['P18', 'P19', 'P20', 'P21', 'P3373']],
    ['Q515', ['P17', 'P18', 'P31', 'P41', 'P47', 'P4290']

    ]
];

const TEST_CASES_EXAMPLE_VALUES = [
    ['Q5', 'P735', 5],
    ['Q515', 'P30', 5]
];


async function main() {
    let anyFailed = false;
    for (let [id, expected] of TEST_CASES_PROPERTY_LABELS) {
        const label = await getPropertyLabel(id);
        try {
            assert.strictEqual(label, expected);
        } catch(e) {
            console.error(`Test case "${id}" failed`);
            console.error(e);
            anyFailed = true;
        }
    }
    for (let [id, expected] of TEST_CASES_PROPERTY_LIST) {
        const properties = await getPropertyList(id);
        try {
            for (let expected_property of expected)
                assert(properties.includes(expected_property));
        } catch(e) {
            console.error(`Test case "${id}" failed`);
            console.error(e);
            anyFailed = true;
        }
    }
    for (let [domainId, propertyId, size] of TEST_CASES_EXAMPLE_VALUES) {
        const values = await getExampleValuesForProperty(domainId, propertyId, size);
        try {
            for (let value of values) {
                assert(value.id.startsWith('http://www.wikidata.org/entity/Q'));
                assert.strictEqual(typeof value.label, 'string');
            }
        } catch(e) {
            console.error(`Test case "${domainId}.${propertyId}" failed`);
            console.error(e);
            anyFailed = true;
        }
    }
    if (anyFailed)
        throw new Error('Some test failed');
}

module.exports = main;
if (!module.parent)
    main();
