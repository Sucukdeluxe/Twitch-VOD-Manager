import { describe, expect, it } from 'vitest';
import { parseGraphqlDataEnvelope, parseGraphqlUser, parseHelixDataArray } from './provider-payload';

describe('provider payload semantics', () => {
    it('accepts only an explicit object-valued GraphQL data envelope', () => {
        expect(parseGraphqlDataEnvelope({ data: { user: null } })).toEqual({ status: 'success', value: { user: null } });
        expect(parseGraphqlDataEnvelope({})).toEqual({ status: 'unavailable' });
        expect(parseGraphqlDataEnvelope({ data: null })).toEqual({ status: 'unavailable' });
        expect(parseGraphqlDataEnvelope('<html>failure</html>')).toEqual({ status: 'unavailable' });
    });

    it('distinguishes an explicit missing GraphQL user from a malformed response', () => {
        expect(parseGraphqlUser({ user: null })).toEqual({ status: 'not-found' });
        expect(parseGraphqlUser({ user: { id: '1' } })).toEqual({ status: 'success', value: { id: '1' } });
        expect(parseGraphqlUser({})).toEqual({ status: 'unavailable' });
        expect(parseGraphqlUser({ user: 'invalid' })).toEqual({ status: 'unavailable' });
    });

    it('accepts an explicit empty Helix data array without accepting missing data', () => {
        expect(parseHelixDataArray({ data: [] })).toEqual({ status: 'success', value: [] });
        expect(parseHelixDataArray({})).toEqual({ status: 'unavailable' });
        expect(parseHelixDataArray({ data: null })).toEqual({ status: 'unavailable' });
        expect(parseHelixDataArray({ data: {} })).toEqual({ status: 'unavailable' });
    });
});
