/*
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */

import { InvalidSearchParameterError, TypeSearchRequest } from 'fhir-works-on-aws-interface';
import { NON_SEARCHABLE_PARAMETERS } from '../constants';
import { CompiledSearchParam, FHIRSearchParametersRegistry, SearchParam } from '../FHIRSearchParametersRegistry';
import { stringQuery } from './typeQueries/stringQuery';
import { dateQuery } from './typeQueries/dateQuery';
import { tokenQuery } from './typeQueries/tokenQuery';
import { numberQuery } from './typeQueries/numberQuery';
import { quantityQuery } from './typeQueries/quantityQuery';
import { referenceQuery } from './typeQueries/referenceQuery';
import getOrSearchValues from './searchOR';
import parseSearchModifiers from './searchModifiers';
import { uriQuery } from './typeQueries/uriQuery';

function typeQueryWithConditions(
    searchParam: SearchParam,
    compiledSearchParam: CompiledSearchParam,
    searchValue: string,
    useKeywordSubFields: boolean,
    baseUrl: string,
    modifier?: string,
): any {
    let typeQuery: any;
    switch (searchParam.type) {
        case 'string':
            typeQuery = stringQuery(compiledSearchParam, searchValue, modifier);
            break;
        case 'date':
            typeQuery = dateQuery(compiledSearchParam, searchValue, modifier);
            break;
        case 'token':
            typeQuery = tokenQuery(compiledSearchParam, searchValue, useKeywordSubFields, modifier);
            break;
        case 'number':
            typeQuery = numberQuery(compiledSearchParam, searchValue, modifier);
            break;
        case 'quantity':
            typeQuery = quantityQuery(compiledSearchParam, searchValue, useKeywordSubFields, modifier);
            break;
        case 'reference':
            typeQuery = referenceQuery(
                compiledSearchParam,
                searchValue,
                useKeywordSubFields,
                baseUrl,
                searchParam.name,
                searchParam.target,
                modifier,
            );
            break;
        case 'uri':
            typeQuery = uriQuery(compiledSearchParam, searchValue, useKeywordSubFields, modifier);
            break;
        case 'composite':
        case 'special':
        default:
            typeQuery = stringQuery(compiledSearchParam, searchValue, modifier);
    }
    // In most cases conditions are used for fields that are an array of objects
    // Ideally we should be using a nested query, but that'd require to update the index mappings.
    //
    // Simply using an array of bool.must is good enough for most cases. The result will contain the correct documents, however it MAY contain additional documents
    // https://www.elastic.co/guide/en/elasticsearch/reference/current/nested.html
    if (compiledSearchParam.condition !== undefined) {
        return {
            bool: {
                must: [
                    typeQuery,
                    {
                        multi_match: {
                            fields: [compiledSearchParam.condition[0], `${compiledSearchParam.condition[0]}.*`],
                            query: compiledSearchParam.condition[2],
                            lenient: true,
                        },
                    },
                ],
            },
        };
    }
    return typeQuery;
}

function searchParamQuery(
    searchParam: SearchParam,
    searchValue: string,
    useKeywordSubFields: boolean,
    baseUrl: string,
    modifier?: string,
): any {
    const splitSearchValue = getOrSearchValues(searchValue);
    let queryList = [];
    for (let i = 0; i < splitSearchValue.length; i += 1) {
        queryList.push(
            searchParam.compiled.map(compiled => {
                return typeQueryWithConditions(
                    searchParam,
                    compiled,
                    splitSearchValue[i],
                    useKeywordSubFields,
                    baseUrl,
                    modifier,
                );
            }),
        );
    }
    // flatten array of arrays of results into one array with results
    queryList = queryList.flat(1);
    if (queryList.length === 1) {
        return queryList[0];
    }
    return {
        bool: {
            should: queryList,
        },
    };
}

function normalizeQueryParams(queryParams: any): { [key: string]: string[] } {
    const normalizedQueryParams: { [key: string]: string[] } = {};

    Object.entries(queryParams).forEach(([searchParameter, searchValue]) => {
        if (typeof searchValue === 'string') {
            normalizedQueryParams[searchParameter] = [searchValue];
            return;
        }
        if (Array.isArray(searchValue) && searchValue.every(s => typeof s === 'string')) {
            normalizedQueryParams[searchParameter] = searchValue;
            return;
        }

        // This may occur if the router has advanced querystring parsing enabled
        // e.g. {{API_URL}}/Patient?name[key]=Smith may be parsed into {"name":{"key":"Smith"}}
        throw new InvalidSearchParameterError(`Invalid search parameter: '${searchParameter}'`);
    });

    return normalizedQueryParams;
}

function searchRequestQuery(
    fhirSearchParametersRegistry: FHIRSearchParametersRegistry,
    request: TypeSearchRequest,
    useKeywordSubFields: boolean,
): any[] {
    const { baseUrl, queryParams, resourceType } = request;
    return Object.entries(normalizeQueryParams(queryParams))
        .filter(([searchParameter]) => !NON_SEARCHABLE_PARAMETERS.includes(searchParameter))
        .flatMap(([searchParameter, searchValues]) => {
            const searchModifier = parseSearchModifiers(searchParameter);
            const fhirSearchParam = fhirSearchParametersRegistry.getSearchParameter(
                resourceType,
                searchModifier.parameterName,
            );
            if (fhirSearchParam === undefined) {
                throw new InvalidSearchParameterError(
                    `Invalid search parameter '${searchModifier.parameterName}' for resource type ${resourceType}`,
                );
            }
            return searchValues.map(searchValue =>
                searchParamQuery(fhirSearchParam, searchValue, useKeywordSubFields, baseUrl, searchModifier.modifier),
            );
        });
}

// eslint-disable-next-line import/prefer-default-export
export const buildQueryForAllSearchParameters = (
    fhirSearchParametersRegistry: FHIRSearchParametersRegistry,
    request: TypeSearchRequest,
    useKeywordSubFields: boolean,
    additionalFilters: any[] = [],
): any => {
    return {
        bool: {
            filter: additionalFilters,
            must: searchRequestQuery(fhirSearchParametersRegistry, request, useKeywordSubFields),
        },
    };
};

export { buildSortClause } from './sort';
