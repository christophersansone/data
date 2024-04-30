import Cache from '@ember-data/json-api';
import type { StructuredDocument } from '@ember-data/request';
import Store from '@ember-data/store';
import type { CacheOperation, NotificationType } from '@ember-data/store/-private/managers/notification-manager';
import type { CacheCapabilitiesManager } from '@ember-data/store/-types/q/cache-store-wrapper';
import type { JsonApiResource } from '@ember-data/store/-types/q/record-data-json-api';
import type { FieldSchema } from '@ember-data/store/-types/q/schema-service';
import type {
  StableDocumentIdentifier,
  StableExistingRecordIdentifier,
  StableRecordIdentifier,
} from '@warp-drive/core-types/identifier';
import type { AttributesSchema, RelationshipsSchema } from '@warp-drive/core-types/schema';
import type { SingleResourceDataDocument } from '@warp-drive/core-types/spec/document';
import type { SingleResourceDocument } from '@warp-drive/core-types/spec/raw';
import { module, test } from '@warp-drive/diagnostic';

type FakeRecord = { [key: string]: unknown; destroy: () => void };
class TestStore extends Store {
  override createCache(wrapper: CacheCapabilitiesManager) {
    return new Cache(wrapper);
  }

  override instantiateRecord(identifier: StableRecordIdentifier) {
    const { id, lid, type } = identifier;
    const record: FakeRecord = { id, lid, type } as unknown as FakeRecord;
    Object.assign(record, (this.cache.peek(identifier) as JsonApiResource).attributes);

    const token = this.notifications.subscribe(
      identifier,
      (_: StableRecordIdentifier, kind: NotificationType, key?: string) => {
        if (kind === 'attributes' && key) {
          record[key] = this.cache.getAttr(identifier, key);
        }
      }
    );

    record.destroy = () => {
      this.notifications.unsubscribe(token);
    };

    return record;
  }

  override teardownRecord(record: FakeRecord) {
    record.destroy();
  }
}

type Schemas<T extends string> = Record<T, { attributes: AttributesSchema; relationships: RelationshipsSchema }>;
class TestSchema<T extends string> {
  declare schemas: Schemas<T>;
  constructor(schemas?: Schemas<T>) {
    this.schemas = schemas || ({} as Schemas<T>);
  }

  attributesDefinitionFor(identifier: { type: T }): AttributesSchema {
    return this.schemas[identifier.type]?.attributes || {};
  }

  _fieldsDefCache: Record<string, Map<string, FieldSchema>> = {};

  fields(identifier: { type: T }): Map<string, FieldSchema> {
    const { type } = identifier;
    let fieldDefs: Map<string, FieldSchema> | undefined = this._fieldsDefCache[type];

    if (fieldDefs === undefined) {
      fieldDefs = new Map();
      this._fieldsDefCache[type] = fieldDefs;

      const attributes = this.attributesDefinitionFor(identifier);
      const relationships = this.relationshipsDefinitionFor(identifier);

      for (const attr of Object.values(attributes)) {
        fieldDefs.set(attr.name, attr);
      }

      for (const rel of Object.values(relationships)) {
        fieldDefs.set(rel.name, rel);
      }
    }

    return fieldDefs;
  }

  relationshipsDefinitionFor(identifier: { type: T }): RelationshipsSchema {
    return this.schemas[identifier.type]?.relationships || {};
  }

  doesTypeExist(type: string) {
    return type in this.schemas ? true : Object.keys(this.schemas).length === 0 ? true : false;
  }
}

module('Integration | @ember-data/json-api Cache.put(<ResourceDataDocument>)', function (hooks) {
  test('simple single resource documents are correctly managed', function (assert) {
    const store = new TestStore();
    store.registerSchema(new TestSchema());

    const responseDocument = store.cache.put({
      content: {
        data: { type: 'user', id: '1', attributes: { name: 'Chris' } },
      },
    }) as SingleResourceDataDocument;
    const identifier = store.identifierCache.getOrCreateRecordIdentifier({
      type: 'user',
      id: '1',
    }) as StableExistingRecordIdentifier;

    assert.equal(responseDocument.data, identifier, 'We were given the correct data back');
  });

  test('single resource documents are correctly cached', function (assert) {
    const store = new TestStore();
    store.registerSchema(new TestSchema());

    const responseDocument = store.cache.put({
      request: { url: 'https://api.example.com/v1/users/1' },
      content: {
        data: { type: 'user', id: '1', attributes: { name: 'Chris' } },
      },
    }) as SingleResourceDataDocument;
    const identifier = store.identifierCache.getOrCreateRecordIdentifier({
      type: 'user',
      id: '1',
    }) as StableExistingRecordIdentifier;

    assert.equal(responseDocument.data, identifier, 'We were given the correct data back');

    const structuredDocument = store.cache.peekRequest({ lid: 'https://api.example.com/v1/users/1' });
    assert.deepEqual(
      structuredDocument as Partial<StructuredDocument<SingleResourceDocument>>,
      {
        request: { url: 'https://api.example.com/v1/users/1' },
        content: {
          lid: 'https://api.example.com/v1/users/1',
          data: identifier,
        },
      },
      'We got the cached structured document back'
    );
    const cachedResponse = store.cache.peek({ lid: 'https://api.example.com/v1/users/1' });
    assert.deepEqual(
      cachedResponse,
      {
        lid: 'https://api.example.com/v1/users/1',
        data: identifier,
      },
      'We got the cached response document back'
    );
  });

  test('data documents respect cacheOptions.key', function (assert) {
    const store = new TestStore();
    store.registerSchemaDefinitionService(new TestSchema());

    const responseDocument = store.cache.put({
      request: { url: 'https://api.example.com/v1/users/1', cacheOptions: { key: 'user-1' } },
      content: {
        data: { type: 'user', id: '1', attributes: { name: 'Chris' } },
      },
    }) as SingleResourceDataDocument;
    const identifier = store.identifierCache.getOrCreateRecordIdentifier({
      type: 'user',
      id: '1',
    }) as StableExistingRecordIdentifier;

    assert.equal(responseDocument.data, identifier, 'We were given the correct data back');

    const structuredDocument = store.cache.peekRequest({ lid: 'user-1' });
    const structuredDocument2 = store.cache.peekRequest({ lid: 'https://api.example.com/v1/users/1' });
    assert.equal(structuredDocument2, null, 'we did not use the url as the key');
    assert.deepEqual(
      structuredDocument as Partial<StructuredDocument<SingleResourceDocument>>,
      {
        request: { url: 'https://api.example.com/v1/users/1', cacheOptions: { key: 'user-1' } },
        content: {
          lid: 'user-1',
          data: identifier,
        },
      },
      'We got the cached structured document back'
    );

    const cachedResponse = store.cache.peek({ lid: 'user-1' });
    const cachedResponse2 = store.cache.peek({ lid: 'https://api.example.com/v1/users/1' });
    assert.equal(cachedResponse2, null, 'we did not use the url as the key');
    assert.deepEqual(
      cachedResponse,
      {
        lid: 'user-1',
        data: identifier,
      },
      'We got the cached response document back'
    );
  });

  test("notifications are generated for create and update of the document's cache key", function (assert) {
    assert.expect(10);
    const store = new TestStore();
    store.registerSchema(new TestSchema());
    const documentIdentifier = store.identifierCache.getOrCreateDocumentIdentifier({
      url: '/api/v1/query?type=user&name=Chris&limit=1',
    })!;

    let isUpdating = false;
    store.notifications.subscribe('document', (identifier: StableDocumentIdentifier, type: CacheOperation) => {
      if (isUpdating) {
        assert.equal(type, 'updated', 'We were notified of an update');
        assert.equal(identifier, documentIdentifier, 'We were notified of the correct document');
      } else {
        assert.equal(type, 'added', 'We were notified of an add');
        assert.equal(identifier, documentIdentifier, 'We were notified of the correct document');
      }
    });

    store.notifications.subscribe(documentIdentifier, (identifier: StableDocumentIdentifier, type: CacheOperation) => {
      if (isUpdating) {
        assert.equal(type, 'updated', 'We were notified of an update');
        assert.equal(identifier, documentIdentifier, 'We were notified of the correct document');
      } else {
        assert.equal(type, 'added', 'We were notified of an add');
        assert.equal(identifier, documentIdentifier, 'We were notified of the correct document');
      }
    });

    store._run(() => {
      const responseDocument = store.cache.put({
        request: {
          url: '/api/v1/query?type=user&name=Chris&limit=1',
        },
        content: {
          data: { type: 'user', id: '1', attributes: { name: 'Chris' } },
        },
      }) as SingleResourceDataDocument;
      const identifier = store.identifierCache.getOrCreateRecordIdentifier({ type: 'user', id: '1' });

      assert.equal(responseDocument.data, identifier, 'We were given the correct data back');
    });

    isUpdating = true;
    store._run(() => {
      const responseDocument2 = store.cache.put({
        request: {
          url: '/api/v1/query?type=user&name=Chris&limit=1',
        },
        content: {
          data: { type: 'user', id: '2', attributes: { name: 'Chris' } },
        },
      }) as SingleResourceDataDocument;
      const identifier2 = store.identifierCache.getOrCreateRecordIdentifier({ type: 'user', id: '2' });
      assert.equal(responseDocument2.data, identifier2, 'We were given the correct data back');
    });
  });

  test('resources are accessible via `peek`', function (assert) {
    const store = new TestStore();
    store.registerSchema(new TestSchema());

    const responseDocument = store.cache.put({
      content: {
        data: { type: 'user', id: '1', attributes: { name: 'Chris' } },
      },
    }) as SingleResourceDataDocument;
    const identifier = store.identifierCache.getOrCreateRecordIdentifier({ type: 'user', id: '1' });

    assert.equal(responseDocument.data, identifier, 'We were given the correct data back');

    let resourceData = store.cache.peek(identifier);

    assert.deepEqual(
      resourceData,
      { type: 'user', id: '1', lid: '@lid:user-1', attributes: { name: 'Chris' }, relationships: {} },
      'We can fetch from the cache'
    );

    const record = store.peekRecord<{ name: string | null }>(identifier);

    assert.equal(record?.name, 'Chris', 'record name is correct');

    store.cache.setAttr(identifier, 'name', 'James');
    resourceData = store.cache.peek(identifier);

    assert.deepEqual(
      resourceData,
      { type: 'user', id: '1', lid: '@lid:user-1', attributes: { name: 'James' }, relationships: {} },
      'Resource Blob is kept updated in the cache after mutation'
    );

    store.cache.put({
      content: {
        data: { type: 'user', id: '1', attributes: { username: '@runspired' } },
      },
    });

    resourceData = store.cache.peek(identifier);
    assert.deepEqual(
      resourceData,
      {
        type: 'user',
        id: '1',
        lid: '@lid:user-1',
        attributes: { name: 'James', username: '@runspired' },
        relationships: {},
      },
      'Resource Blob is kept updated in the cache after additional put'
    );

    store.cache.rollbackAttrs(identifier);
    resourceData = store.cache.peek(identifier);
    assert.deepEqual(
      resourceData,
      {
        type: 'user',
        id: '1',
        lid: '@lid:user-1',
        attributes: { name: 'Chris', username: '@runspired' },
        relationships: {},
      },
      'Resource Blob is kept updated in the cache after rollback'
    );
  });

  test('single resource relationships are accessible via `peek`', function (assert) {
    const store = new TestStore();

    store.registerSchema(
      new TestSchema<'user'>({
        user: {
          attributes: {
            name: { kind: 'attribute', name: 'name', type: null },
          },
          relationships: {
            bestFriend: {
              kind: 'belongsTo',
              type: 'user',
              name: 'bestFriend',
              options: {
                async: false,
                inverse: 'bestFriend',
              },
            },
            worstEnemy: {
              kind: 'belongsTo',
              type: 'user',
              name: 'worstEnemy',
              options: {
                async: false,
                inverse: null,
              },
            },
            friends: {
              kind: 'hasMany',
              type: 'user',
              name: 'friends',
              options: {
                async: false,
                inverse: 'friends',
              },
            },
          },
        },
      })
    );

    let responseDocument: SingleResourceDataDocument;
    store._run(() => {
      responseDocument = store.cache.put({
        content: {
          data: {
            type: 'user',
            id: '1',
            attributes: { name: 'Chris' },
            relationships: {
              bestFriend: {
                data: { type: 'user', id: '2' },
              },
              worstEnemy: {
                data: { type: 'user', id: '3' },
              },
              friends: {
                data: [
                  { type: 'user', id: '2' },
                  { type: 'user', id: '3' },
                ],
              },
            },
          },
          included: [
            {
              type: 'user',
              id: '2',
              attributes: { name: 'Wesley' },
              relationships: {
                bestFriend: {
                  data: { type: 'user', id: '1' },
                },
                friends: {
                  data: [
                    { type: 'user', id: '1' },
                    { type: 'user', id: '3' },
                  ],
                },
              },
            },
            {
              type: 'user',
              id: '3',
              attributes: { name: 'Rey' },
              relationships: {
                bestFriend: {
                  data: null,
                },
                friends: {
                  data: [
                    { type: 'user', id: '1' },
                    { type: 'user', id: '2' },
                  ],
                },
              },
            },
          ],
        },
      }) as SingleResourceDataDocument;
    });
    const identifier1 = store.identifierCache.getOrCreateRecordIdentifier({ type: 'user', id: '1' });
    const identifier2 = store.identifierCache.getOrCreateRecordIdentifier({ type: 'user', id: '2' });
    const identifier3 = store.identifierCache.getOrCreateRecordIdentifier({ type: 'user', id: '3' });

    assert.equal(responseDocument!.data, identifier1, 'We were given the correct data back');

    const resourceData1 = store.cache.peek(identifier1);
    const resourceData2 = store.cache.peek(identifier2);
    const resourceData3 = store.cache.peek(identifier3);

    assert.deepEqual(
      resourceData1,
      {
        type: 'user',
        id: '1',
        lid: '@lid:user-1',
        attributes: { name: 'Chris' },
        relationships: {
          bestFriend: {
            data: identifier2,
          },
          friends: {
            data: [identifier2, identifier3],
          },
          worstEnemy: {
            data: identifier3,
          },
        },
      },
      'We can fetch from the cache'
    );
    assert.deepEqual(
      resourceData2,
      {
        type: 'user',
        id: '2',
        lid: '@lid:user-2',
        attributes: { name: 'Wesley' },
        relationships: {
          bestFriend: {
            data: identifier1,
          },
          friends: {
            data: [identifier1, identifier3],
          },
        },
      },
      'We can fetch included data from the cache'
    );
    assert.deepEqual(
      resourceData3,
      {
        type: 'user',
        id: '3',
        lid: '@lid:user-3',
        attributes: { name: 'Rey' },
        relationships: {
          bestFriend: {
            data: null,
          },
          friends: {
            data: [identifier1, identifier2],
          },
        },
      },
      'We can fetch more included data from the cache'
    );
  });

  test('generated default values are retained', function (assert) {
    const store = new TestStore();
    let i = 0;

    store.registerSchema(
      new TestSchema<'user'>({
        user: {
          attributes: {
            name: {
              kind: 'attribute',
              name: 'name',
              type: null,
              options: {
                defaultValue: () => {
                  i++;
                  return `Name ${i}`;
                },
              },
            },
          },
          relationships: {},
        },
      })
    );

    store._run(() => {
      store.cache.put({
        content: {
          data: {
            type: 'user',
            id: '1',
            attributes: {},
          },
        },
      }) as SingleResourceDataDocument;
    });
    const identifier = store.identifierCache.getOrCreateRecordIdentifier({ type: 'user', id: '1' });

    const name1 = store.cache.getAttr(identifier, 'name');
    assert.equal(name1, 'Name 1', 'The default value was generated');
    const name2 = store.cache.getAttr(identifier, 'name');
    assert.equal(name2, 'Name 1', 'The default value was cached');

    store.cache.setAttr(identifier, 'name', 'Chris');
    const name3 = store.cache.getAttr(identifier, 'name');
    assert.equal(name3, 'Chris', 'The value was updated');

    store.cache.setAttr(identifier, 'name', null);
    const name4 = store.cache.getAttr(identifier, 'name');
    assert.equal(name4, null, 'Null was set and maintained');

    store.cache.rollbackAttrs(identifier);
    const name5 = store.cache.getAttr(identifier, 'name');
    assert.equal(name5, 'Name 2', 'The default value was regenerated');

    store._run(() => {
      store.cache.put({
        content: {
          data: {
            type: 'user',
            id: '1',
            attributes: {
              name: 'Tomster',
            },
          },
        },
      }) as SingleResourceDataDocument;
    });

    const name6 = store.cache.getAttr(identifier, 'name');
    assert.equal(name6, 'Tomster', 'The value was updated on put');
  });
});
