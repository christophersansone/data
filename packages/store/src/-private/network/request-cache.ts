/**
 * @module @ember-data/store
 */
import { assert } from '@ember/debug';

import type {
  FindRecordQuery,
  Operation,
  Request,
  RequestState,
  SaveRecordMutation,
} from '@ember-data/types/q/fetch-manager';
import type { RecordIdentifier, StableRecordIdentifier } from '@ember-data/types/q/identifier';

import Store from '../store-service';

const Touching: unique symbol = Symbol('touching');
export const RequestPromise: unique symbol = Symbol('promise');

interface InternalRequest extends RequestState {
  [Touching]: RecordIdentifier[];
  [RequestPromise]?: Promise<any>;
}

type RecordOperation = FindRecordQuery | SaveRecordMutation;

function hasRecordIdentifier(op: Operation): op is RecordOperation {
  return 'recordIdentifier' in op;
}

/**
 * The RequestStateService is used to track the state of requests
 * for fetching or updating known resource identifies that are inflight.
 *
 * @class RequestStateService
 * @public
 */
export default class RequestStateService {
  _pending: { [lid: string]: InternalRequest[] } = Object.create(null);
  _done: Map<StableRecordIdentifier, InternalRequest[]> = new Map();
  _subscriptions: { [lid: string]: Function[] } = Object.create(null);
  _toFlush: InternalRequest[] = [];
  _store: Store;

  constructor(store) {
    this._store = store;
  }

  _clearEntries(identifier: StableRecordIdentifier) {
    this._done.delete(identifier);
  }

  _enqueue<T>(promise: Promise<T>, queryRequest: Request): Promise<T> {
    let query = queryRequest.data[0];
    if (hasRecordIdentifier(query)) {
      let lid = query.recordIdentifier.lid;
      let type = query.op === 'saveRecord' ? ('mutation' as const) : ('query' as const);
      if (!this._pending[lid]) {
        this._pending[lid] = [];
      }
      let request: InternalRequest = {
        state: 'pending',
        request: queryRequest,
        type,
      } as InternalRequest;
      request[Touching] = [query.recordIdentifier];
      request[RequestPromise] = promise;
      this._pending[lid].push(request);
      this._triggerSubscriptions(request);
      return promise.then(
        (result) => {
          this._dequeue(lid, request);
          let finalizedRequest = {
            state: 'fulfilled',
            request: queryRequest,
            type,
            response: { data: result },
          } as InternalRequest;
          finalizedRequest[Touching] = request[Touching];
          this._addDone(finalizedRequest);
          this._triggerSubscriptions(finalizedRequest);
          return result;
        },
        (error) => {
          this._dequeue(lid, request);
          let finalizedRequest = {
            state: 'rejected',
            request: queryRequest,
            type,
            response: { data: error },
          } as InternalRequest;
          finalizedRequest[Touching] = request[Touching];
          this._addDone(finalizedRequest);
          this._triggerSubscriptions(finalizedRequest);
          throw error;
        }
      );
    }
    assert(`Expected a well formed  query`);
  }

  _triggerSubscriptions(req: InternalRequest): void {
    if (req.state === 'pending') {
      this._flushRequest(req);
      return;
    }
    this._toFlush.push(req);

    if (this._toFlush.length === 1) {
      this._store.notifications._onNextFlush(() => {
        this._flush();
      });
    }
  }

  _flush(): void {
    this._toFlush.forEach((req) => {
      this._flushRequest(req);
    });
    this._toFlush = [];
  }

  _flushRequest(req: InternalRequest): void {
    req[Touching].forEach((identifier: StableRecordIdentifier) => {
      if (this._subscriptions[identifier.lid]) {
        this._subscriptions[identifier.lid].forEach((callback) => callback(req));
      }
    });
  }

  _dequeue(lid: string, request: InternalRequest) {
    this._pending[lid] = this._pending[lid].filter((req) => req !== request);
  }

  _addDone(request: InternalRequest) {
    request[Touching].forEach((identifier) => {
      // TODO add support for multiple
      let requestDataOp = request.request.data[0].op;
      let requests = this._done.get(identifier);

      if (requests) {
        requests = requests.filter((req) => {
          // TODO add support for multiple
          let data;
          if (req.request.data instanceof Array) {
            data = req.request.data[0];
          } else {
            data = req.request.data;
          }
          return data.op !== requestDataOp;
        });
      }
      requests = requests || [];
      requests.push(request);
      this._done.set(identifier, requests);
    });
  }

  /**
   * Subscribe to requests for a given resource identity.
   *
   * The callback will receive the current state of the request.
   *
   * ```ts
   * interface RequestState {
   *   state: 'pending' | 'fulfilled' | 'rejected';
   *   type: 'query' | 'mutation';
   *   request: Request;
   *   response?: { data: unknown };
   * }
   * ```
   *
   * Note: It should be considered dangerous to use this API for more than simple
   * state derivation or debugging. The `request` and `response` properties are poorly
   * spec'd and may change unexpectedly when shifting what Handlers are in use or how
   * requests are issued from the Store.
   *
   * We expect to revisit this API in the near future as we continue to refine the
   * RequestManager ergonomics, as a simpler but more powerful direct integration
   * with the RequestManager for these purposes is likely to be a better long-term
   * design.
   *
   * @method subscribeForRecord
   * @public
   * @param {StableRecordIdentifier} identifier
   * @param {(state: RequestState) => void} callback
   */
  subscribeForRecord(identifier: RecordIdentifier, callback: (requestState: RequestState) => void) {
    if (!this._subscriptions[identifier.lid]) {
      this._subscriptions[identifier.lid] = [];
    }
    this._subscriptions[identifier.lid].push(callback);
  }

  /**
   * Retrieve all active requests for a given resource identity.
   *
   * @method getPendingRequestsForRecord
   * @public
   * @param {StableRecordIdentifier} identifier
   * @returns {RequestState[]} an array of request states for any pending requests for the given identifier
   */
  getPendingRequestsForRecord(identifier: RecordIdentifier): RequestState[] {
    if (this._pending[identifier.lid]) {
      return this._pending[identifier.lid];
    }
    return [];
  }

  /**
   * Retrieve the last completed request for a given resource identity.
   *
   * @method getLastRequestForRecord
   * @public
   * @param {StableRecordIdentifier} identifier
   * @returns {RequestState | null} the state of the most recent request for the given identifier
   */
  getLastRequestForRecord(identifier: RecordIdentifier): RequestState | null {
    let requests = this._done.get(identifier);
    if (requests) {
      return requests[requests.length - 1];
    }
    return null;
  }
}
