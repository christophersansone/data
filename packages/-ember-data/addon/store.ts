import JSONAPICache from '@ember-data/json-api';
import {
  adapterFor,
  cleanup,
  LegacyNetworkHandler,
  normalize,
  pushPayload,
  serializeRecord,
  serializerFor,
} from '@ember-data/legacy-compat';
import { FetchManager } from '@ember-data/legacy-compat/-private';
import type Model from '@ember-data/model';
import type { ModelStore } from '@ember-data/model/-private/model';
import { buildSchema, instantiateRecord, modelFor, teardownRecord } from '@ember-data/model/hooks';
import RequestManager from '@ember-data/request';
import Fetch from '@ember-data/request/fetch';
import BaseStore, { CacheHandler } from '@ember-data/store';
import type { Cache } from '@ember-data/store/-types/cache/cache';
import type { CacheCapabilitiesManager } from '@ember-data/store/-types/q/cache-store-wrapper';
import type { ModelSchema } from '@ember-data/store/-types/q/ds-model';
import type { StableRecordIdentifier } from '@ember-data/store/-types/q/identifier';

export default class Store extends BaseStore {
  declare _fetchManager: FetchManager;

  constructor(args?: Record<string, unknown>) {
    super(args);
    this.requestManager = new RequestManager();
    this.requestManager.use([LegacyNetworkHandler, Fetch]);
    this.requestManager.useCache(CacheHandler);
    this.registerSchema(buildSchema(this));
  }

  createCache(storeWrapper: CacheCapabilitiesManager): Cache {
    return new JSONAPICache(storeWrapper);
  }

  instantiateRecord(
    this: ModelStore,
    identifier: StableRecordIdentifier,
    createRecordArgs: Record<string, unknown>
  ): Model {
    return instantiateRecord.call(this, identifier, createRecordArgs);
  }

  teardownRecord(record: Model): void {
    teardownRecord.call(this, record);
  }

  modelFor(type: string): ModelSchema {
    return modelFor.call(this, type) || super.modelFor(type);
  }

  adapterFor = adapterFor;
  serializerFor = serializerFor;
  pushPayload = pushPayload;
  normalize = normalize;
  serializeRecord = serializeRecord;

  destroy() {
    cleanup.call(this);
    super.destroy();
  }
}
