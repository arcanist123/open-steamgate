// The questions a system is asked, as data.
//
// Nothing here is imported from the application, and nothing here is
// imported at all: a case is a request and what the answer must look like,
// so the same array can be pointed at OSD on Node, at the Bun binary, at
// the browser preview behind its static server, or — with `--logon env` and
// the read-only tags — at a system that is not ours. `test/conformance/run.mjs`
// performs them; `test/conformance.mjs` runs the read-only ones under mocha
// against the tree's own server. docs/conformance.md is the contract.
//
// A case is
//   {id, name, request: {method, path, headers?, body?, csrf?},
//    expect: {status, contentType?, headers?, jsonPath?, contains?,
//             xpathish?, bytes?},
//    tags: [...]}
//
// `{base}` in a path or in an expected value is the base URL of the host
// under test. `csrf: true` asks the runner for a token from the service the
// path names, the way a client fetches one, so nothing hard-codes ours.
//
// Every case carries `read` or `mutating`. `mutating` is off by default and
// must never be aimed at a system that is not ours: those cases create,
// change and delete rows, and they are ordered — they run as a set.

const DEMO = "/sap/opu/odata/sap/ZSTG_DEMO_SRV";
const SADL = "/sap/opu/odata/sap/ZSTG_SADL_SRV";
const CDS = "/sap/opu/odata/sap/ZC_STG_TRAVEL_CDS";
const CUBE = "/sap/opu/odata/sap/ZC_STG_FLIGHTCUBE_CDS";
const STATUS = "/sap/opu/odata/sap/ZOSD_STATUS_SRV";
const ADT = "/sap/bc/adt";

const json = {accept: "application/json"};
const writeHeaders = {"content-type": "application/json"};

export const cases = [

  // ---------------------------------------------------------------- the door

  {
    id: "root-redirects-to-the-launchpad",
    name: "the port's front door is the launchpad",
    request: {method: "GET", path: "/", redirect: "manual"},
    expect: {status: 302, headers: {location: "/app/flp.html"}},
    tags: ["read", "app"],
  },
  {
    id: "launchpad-page",
    name: "the launchpad names what this system serves",
    request: {method: "GET", path: "/app/flp.html"},
    expect: {status: 200, contentType: "text/html", contains: ["Travels", "Bookings"]},
    tags: ["read", "app"],
  },
  {
    id: "launchpad-packs",
    name: "the tiles the packs declare are served as JSON",
    request: {method: "GET", path: "/app/packs.json"},
    expect: {status: 200, jsonPath: [{path: "tiles", type: "array"}]},
    tags: ["read", "app"],
  },

  // ------------------------------------------------- the service and its model

  {
    id: "service-document",
    name: "the service document names the entity sets",
    request: {method: "GET", path: `${DEMO}/`, headers: json},
    expect: {
      status: 200,
      jsonPath: [{path: "d.EntitySets", contains: ["TravelSet", "BookingSet", "PhotoSet"]}],
    },
    tags: ["read", "odata"],
  },
  {
    id: "metadata",
    name: "$metadata is XML, v2, with the entity type and its set",
    request: {method: "GET", path: `${DEMO}/$metadata`},
    expect: {
      status: 200,
      contentType: "application/xml",
      headers: {dataserviceversion: "2.0"},
      xpathish: [
        {element: "EntityType", attrs: {Name: "Travel"}},
        {element: "EntitySet", attrs: {Name: "TravelSet", EntityType: "ZSTG_DEMO_SRV.Travel"}},
        {element: "NavigationProperty", attrs: {Name: "to_Bookings"}},
      ],
    },
    tags: ["read", "metadata"],
  },
  {
    id: "metadata-media-entity",
    name: "a media entity is marked m:HasStream in the model",
    request: {method: "GET", path: `${DEMO}/$metadata`},
    expect: {status: 200, xpathish: [{element: "EntityType", attrs: {Name: "Photo", "m:HasStream": "true"}}]},
    tags: ["read", "metadata", "media"],
  },
  {
    id: "csrf-token-fetch",
    name: "a token fetch is answered with a token",
    request: {method: "GET", path: `${DEMO}/`, headers: {"x-csrf-token": "Fetch"}},
    expect: {status: 200, headers: {"x-csrf-token": {matches: "^.+$"}}},
    tags: ["read", "odata"],
  },
  {
    id: "unknown-service-is-404",
    name: "a service nobody registered is not served",
    request: {method: "GET", path: "/sap/opu/odata/sap/ZSTG_NO_SUCH_SRV/$metadata"},
    expect: {status: 404},
    tags: ["read", "error"],
  },

  // ------------------------------------------------------------------- reading

  {
    id: "entityset-json",
    name: "an entity set as OData v2 JSON, with __metadata",
    request: {method: "GET", path: `${DEMO}/TravelSet?$format=json`},
    expect: {
      status: 200,
      jsonPath: [
        {path: "d.results", length: 4},
        {path: "d.results[0].TravelId", equals: "T0001"},
        {path: "d.results[0].Seats", equals: 2},
        {path: "d.results[0].__metadata.uri", equals: "{base}" + DEMO + "/TravelSet('T0001')"},
        {path: "d.results[0].__metadata.type", equals: "ZSTG_DEMO_SRV.Travel"},
      ],
    },
    tags: ["read", "odata"],
  },
  {
    id: "top-skip-inlinecount",
    name: "$top / $skip / $inlinecount page the set and count it",
    request: {method: "GET", path: `${DEMO}/TravelSet?$top=2&$skip=1&$inlinecount=allpages`, headers: json},
    expect: {
      status: 200,
      jsonPath: [
        {path: "d.results[*].TravelId", deepEquals: ["T0002", "T0003"]},
        {path: "d.__count", equals: "2"},
      ],
    },
    tags: ["read", "query"],
  },
  {
    id: "single-entity-by-key",
    name: "one entity by its key",
    request: {method: "GET", path: `${DEMO}/TravelSet('T0003')`, headers: json},
    expect: {
      status: 200,
      jsonPath: [
        {path: "d.Description", equals: "Aarhus to Odense"},
        {path: "d.__metadata.type", equals: "ZSTG_DEMO_SRV.Travel"},
      ],
    },
    tags: ["read", "odata"],
  },
  {
    id: "filter-select-options",
    name: "$filter reaches the DPC as select-options (eq / or)",
    request: {method: "GET", path: `${DEMO}/TravelSet?$filter=${encodeURIComponent("Status eq 'X' or Status eq 'Z'")}`, headers: json},
    expect: {status: 200, jsonPath: [{path: "d.results[*].TravelId", deepEquals: ["T0003"]}]},
    tags: ["read", "query"],
  },
  {
    id: "count",
    name: "$count is a bare number",
    request: {method: "GET", path: `${DEMO}/TravelSet/$count`},
    expect: {status: 200, contains: ["4"]},
    tags: ["read", "query"],
  },
  {
    id: "not-found-is-an-odata-error",
    name: "a key nobody has is a 404 with an OData error body",
    request: {method: "GET", path: `${DEMO}/TravelSet('NOPE')`, headers: json},
    expect: {status: 404, jsonPath: [{path: "error.code", matches: "ENTITY_NOT_FOUND"}]},
    tags: ["read", "error"],
  },

  // ---------------------------------------------------------------- navigation

  {
    id: "navigation-below-the-parent",
    name: "a navigation property read as a URL segment",
    request: {method: "GET", path: `${DEMO}/TravelSet('T0001')/to_Bookings`, headers: json},
    expect: {
      status: 200,
      jsonPath: [
        {path: "d.results[*].BookingId", deepEquals: ["B001", "B002"]},
        {path: "d.results[0].FlightDate", matches: "^\\/Date\\(\\d+\\)\\/$"},
      ],
    },
    tags: ["read", "nav"],
  },
  {
    id: "expand-to-many",
    name: "$expand nests the children in the parent",
    request: {method: "GET", path: `${DEMO}/TravelSet?$expand=to_Bookings&$top=1`, headers: json},
    expect: {
      status: 200,
      jsonPath: [
        {path: "d.results[0].to_Bookings.results", length: 2},
        {path: "d.results[0].to_Bookings.results[1].Customer", equals: "Grace Hopper"},
      ],
    },
    tags: ["read", "nav"],
  },
  {
    id: "expand-to-one",
    name: "$expand upwards, from a two-key child",
    request: {method: "GET", path: `${DEMO}/BookingSet(TravelId='T0002',BookingId='B001')?$expand=to_Travel`, headers: json},
    expect: {status: 200, jsonPath: [{path: "d.to_Travel.Description", equals: "Copenhagen to Aarhus"}]},
    tags: ["read", "nav"],
  },
  {
    id: "deferred-navigation",
    name: "an unexpanded navigation property is __deferred at its own URL",
    request: {method: "GET", path: `${DEMO}/TravelSet('T0002')`, headers: json},
    expect: {
      status: 200,
      jsonPath: [{path: "d.to_Bookings.__deferred.uri", equals: "{base}" + DEMO + "/TravelSet('T0002')/to_Bookings"}],
    },
    tags: ["read", "nav"],
  },

  // ----------------------------------------------- function imports, value help

  {
    id: "function-import-read",
    name: "a GET function import returns its scalar",
    request: {method: "GET", path: `${DEMO}/TravelCount?Status='A'`, headers: json},
    expect: {status: 200, jsonPath: [{path: "d.TravelCount", equals: 3}]},
    tags: ["read", "function"],
  },
  {
    id: "value-help-set",
    name: "a set backed by a search help answers its rows",
    request: {method: "GET", path: `${DEMO}/StatusVHSet?$format=json`},
    expect: {
      status: 200,
      jsonPath: [
        {path: "d.results", minLength: 2},
        {path: "d.results[0].Status", equals: "A"},
        {path: "d.results[0].Text", equals: "Accepted"},
      ],
    },
    tags: ["read", "valuehelp"],
  },

  // --------------------------------------------------------------------- media

  {
    id: "media-entity-json",
    name: "a media entity says where its bytes are",
    request: {method: "GET", path: `${DEMO}/PhotoSet('T0001')?$format=json`},
    expect: {
      status: 200,
      jsonPath: [
        {path: "d.__metadata.media_src", equals: "{base}" + DEMO + "/PhotoSet('T0001')/$value"},
        {path: "d.FileName", equals: "t0001.png"},
      ],
    },
    tags: ["read", "media"],
  },
  {
    id: "media-entity-value",
    name: "$value is the bytes, with the right content type",
    request: {method: "GET", path: `${DEMO}/PhotoSet('T0001')/$value`},
    expect: {status: 200, contentType: "image/png", bytes: {length: 930, prefixHex: "89504e470d0a1a0a"}},
    tags: ["read", "media"],
  },
  {
    id: "media-url-on-the-parent",
    name: "the row points at the picture, which is what the app renders",
    request: {method: "GET", path: `${DEMO}/TravelSet('T0003')?$format=json`},
    expect: {
      status: 200,
      jsonPath: [{path: "d.PhotoUrl", equals: "../sap/opu/odata/sap/ZSTG_DEMO_SRV/PhotoSet('T0003')/$value"}],
    },
    tags: ["read", "media"],
  },

  // ---------------------------------------------------------------------- SADL

  {
    id: "sadl-metadata",
    name: "the SADL service annotates its cube and its line items",
    request: {method: "GET", path: `${SADL}/$metadata`},
    expect: {
      status: 200,
      contentType: "application/xml",
      xpathish: [{element: "EntitySet", attrs: {Name: "Zc_Stg_TravelcubeSet"}}],
      contains: ['sap:semantics="aggregate"', 'Term="com.sap.vocabularies.UI.v1.LineItem"'],
    },
    tags: ["read", "sadl", "metadata"],
  },
  {
    id: "sadl-filter-and-orderby",
    name: "$filter and $orderby over a CDS projection",
    request: {method: "GET", path: `${SADL}/Zc_Stg_TravelSet?$filter=${encodeURIComponent("STATUS eq 'A'")}&$orderby=${encodeURIComponent("TRAVELID desc")}`, headers: json},
    expect: {status: 200, jsonPath: [{path: "d.results[*].TRAVELID", deepEquals: ["T0009", "T0002", "T0001"]}]},
    tags: ["read", "sadl", "query"],
  },
  {
    id: "sadl-navigation",
    name: "an association of a CDS view is a navigation property",
    request: {method: "GET", path: `${SADL}/Zc_Stg_TravelSet('T0001')/TO_BOOKINGS`, headers: json},
    expect: {status: 200, jsonPath: [{path: "d.results[*].BOOKINGID", deepEquals: ["B001", "B002"]}]},
    tags: ["read", "sadl", "nav"],
  },
  {
    id: "sadl-virtual-elements",
    name: "a virtual element is filled by ABAP after the read",
    request: {method: "GET", path: `${SADL}/Zc_Stg_TravelSet('T0003')?$format=json`},
    expect: {
      status: 200,
      jsonPath: [{path: "d.OCCUPANCY", equals: "40% of 10"}, {path: "d.FREESEATS", equals: 4}],
    },
    tags: ["read", "sadl"],
  },
  {
    id: "sadl-refuses-a-virtual-filter",
    name: "SADL refuses what the database cannot do, instead of failing in SQL",
    request: {method: "GET", path: `${SADL}/Zc_Stg_TravelSet?$filter=${encodeURIComponent("OCCUPANCY eq 'x'")}`, headers: json},
    expect: {status: 400, jsonPath: [{path: "error.message.value", matches: "is a virtual element"}]},
    tags: ["read", "sadl", "error"],
  },

  // ----------------------------------------------------------------- analytics

  {
    id: "cube-metadata",
    name: "the cube's dimensions and measures are marked in $metadata",
    request: {method: "GET", path: `${SADL}/$metadata`},
    expect: {
      status: 200,
      xpathish: [
        {element: "EntityType", attrs: {Name: "Zc_Stg_Flightcube", "sap:semantics": "aggregate"}},
        {element: "Property", attrs: {Name: "AIRLINE", "sap:aggregation-role": "dimension"}},
        {element: "Property", attrs: {Name: "REVENUE", Type: "Edm.Decimal", "sap:aggregation-role": "measure"}},
      ],
    },
    tags: ["read", "analytics", "metadata"],
  },
  {
    id: "cube-group-by",
    name: "$select on a cube becomes GROUP BY, and the measures are summed",
    request: {method: "GET", path: `${SADL}/Zc_Stg_FlightcubeSet?$select=AIRLINE,SEATS,REVENUE&$orderby=AIRLINE&$format=json`},
    expect: {
      status: 200,
      jsonPath: [
        {path: "d.results[*].AIRLINE", deepEquals: ["AA", "BA", "LH", "SQ"]},
        {path: "d.results[0].SEATS", equals: 12},
        {path: "d.results[0].REVENUE", number: 1710},
      ],
    },
    tags: ["read", "analytics"],
  },
  {
    id: "cube-filter-order-page-count",
    name: "the aggregated rows are filtered, ordered, paged and counted",
    request: {method: "GET", path: `${SADL}/Zc_Stg_FlightcubeSet?$select=AIRLINE,FLIGHTMONTH,SEATS&$filter=${encodeURIComponent("STATUS eq 'A'")}&$orderby=${encodeURIComponent("SEATS desc,AIRLINE")}&$top=2&$inlinecount=allpages&$format=json`},
    expect: {
      status: 200,
      jsonPath: [
        {path: "d.results", length: 2},
        {path: "d.results[*].SEATS", deepEquals: [3, 3]},
        {path: "d.__count", number: 12},
      ],
    },
    tags: ["read", "analytics"],
  },

  // --------------------------------------------------- a published CDS service

  {
    id: "cds-service-document",
    name: "@OData.publish made a service of the view and its associated one",
    request: {method: "GET", path: `${CDS}/`, headers: json},
    expect: {status: 200, jsonPath: [{path: "d.EntitySets", deepEquals: ["ZC_STG_TRAVEL", "ZC_STG_BOOKING"]}]},
    tags: ["read", "cds"],
  },
  {
    id: "cds-metadata",
    name: "the published model carries both types and the navigation between them",
    request: {method: "GET", path: `${CDS}/$metadata`},
    expect: {
      status: 200,
      contentType: "application/xml",
      xpathish: [
        {element: "EntityType", attrs: {Name: "ZC_STG_TRAVELType"}},
        {element: "EntityType", attrs: {Name: "ZC_STG_BOOKINGType"}},
        {element: "EntitySet", attrs: {Name: "ZC_STG_TRAVEL", EntityType: "ZC_STG_TRAVEL_CDS.ZC_STG_TRAVELType"}},
        {element: "NavigationProperty", attrs: {Name: "to_Bookings"}},
        {element: "NavigationProperty", attrs: {Name: "to_Travel"}},
      ],
    },
    tags: ["read", "cds", "metadata"],
  },
  {
    id: "cds-rows",
    name: "the published set reads, filters, and carries its virtual elements",
    request: {method: "GET", path: `${CDS}/ZC_STG_TRAVEL?$format=json&$filter=${encodeURIComponent("STATUS eq 'A'")}`},
    expect: {
      status: 200,
      jsonPath: [
        {path: "d.results[*].TRAVELID", deepEquals: ["T0001", "T0002", "T0009"]},
        {path: "d.results[0].OCCUPANCY", equals: "20% of 10"},
      ],
    },
    tags: ["read", "cds"],
  },
  {
    id: "cds-navigation",
    name: "to_Bookings below the parent carries the rows the ON condition selects",
    request: {method: "GET", path: `${CDS}/ZC_STG_TRAVEL('T0002')/to_Bookings?$format=json`},
    expect: {
      status: 200,
      jsonPath: [
        {path: "d.results[*].TRAVELID", deepEquals: ["T0002"]},
        {path: "d.results[*].BOOKINGID", deepEquals: ["B001"]},
      ],
    },
    tags: ["read", "cds", "nav"],
  },
  {
    id: "cds-expand",
    name: "$expand on the published service nests the children",
    request: {method: "GET", path: `${CDS}/ZC_STG_TRAVEL?$top=1&$expand=to_Bookings&$format=json`},
    expect: {
      status: 200,
      jsonPath: [{path: "d.results[0].to_Bookings.results[*].BOOKINGID", deepEquals: ["B001", "B002"]}],
    },
    tags: ["read", "cds", "nav"],
  },
  {
    id: "cds-cube-service-document",
    name: "an analytical view is published as its own service too",
    request: {method: "GET", path: `${CUBE}/`, headers: json},
    expect: {status: 200, jsonPath: [{path: "d.EntitySets", deepEquals: ["ZC_STG_FLIGHTCUBE"]}]},
    tags: ["read", "cds", "analytics"],
  },

  // ------------------------------------------------------------- what is running

  {
    id: "status-metadata",
    name: "the status service is a service like any other",
    request: {method: "GET", path: `${STATUS}/$metadata`},
    expect: {
      status: 200,
      contentType: "application/xml",
      xpathish: [
        {element: "EntitySet", attrs: {Name: "SystemSet"}},
        {element: "EntitySet", attrs: {Name: "ProcessSet"}},
      ],
    },
    tags: ["read", "status", "metadata"],
  },
  {
    id: "status-system",
    name: "SystemSet has exactly one row: the system answering",
    request: {method: "GET", path: `${STATUS}/SystemSet?$format=json`},
    expect: {
      status: 200,
      jsonPath: [
        {path: "d.results", length: 1},
        {path: "d.results[0].Sid", matches: "^\\S+"},
        {path: "d.results[0].HostKind", matches: "^\\S+"},
        {path: "d.results[0].SnapAt", matches: "^\\d{4}-\\d{2}-\\d{2}T"},
      ],
    },
    tags: ["read", "status"],
  },
  {
    id: "status-processes",
    name: "ProcessSet names at least the process that answered",
    request: {method: "GET", path: `${STATUS}/ProcessSet?$format=json`},
    expect: {
      status: 200,
      jsonPath: [
        {path: "d.results", minLength: 1},
        {path: "d.results[0].Role", matches: "facade|work"},
      ],
    },
    tags: ["read", "status"],
  },
  {
    id: "status-ports",
    name: "the ports of the system are part of the same snapshot",
    request: {method: "GET", path: `${STATUS}/PortSet?$format=json`},
    expect: {status: 200, jsonPath: [{path: "d.results", minLength: 1}]},
    tags: ["read", "status"],
  },

  // ------------------------------------------------------- pages behind the ICF

  {
    id: "icf-zork",
    name: "an ICF page is served by its handler class",
    request: {method: "GET", path: "/sap/bc/zork"},
    expect: {status: 200, contentType: "text/html", contains: ["ZORK"]},
    tags: ["read", "icf"],
  },
  {
    id: "icf-demo",
    name: "a pack's own page is served under its ICF path",
    request: {method: "GET", path: "/sap/bc/zo4d_demo"},
    expect: {status: 200, contentType: "text/html"},
    tags: ["read", "icf"],
  },

  // -------------------------------------------------------------- the ADT door

  {
    id: "adt-discovery",
    name: "the ADT discovery document is an Atom service document",
    request: {method: "GET", path: `${ADT}/discovery`},
    expect: {
      status: 200,
      contentType: "atomsvc+xml",
      contains: ["<app:service", "<app:workspace>", "<app:collection href=\"/sap/bc/adt/"],
    },
    tags: ["read", "adt"],
  },
  {
    id: "adt-core-discovery-token",
    name: "the handshake at core/discovery issues a CSRF token",
    request: {method: "HEAD", path: `${ADT}/core/discovery`, headers: {"x-csrf-token": "fetch"}},
    expect: {status: 200, headers: {"x-csrf-token": {matches: "^.+$"}}},
    tags: ["read", "adt"],
  },

  // -------------------------------------------------------------------- writes
  //
  // Off by default, and ordered: these are one round trip through the DPC
  // (a create, the ETag contract its metadata promises, the writes that
  // honour it, a deep insert and a $batch), and the last of them puts the
  // tree back as it was.

  {
    id: "write-create",
    name: "POST creates an entity and says where it is",
    request: {
      method: "POST", path: `${DEMO}/TravelSet`, csrf: true, headers: writeHeaders,
      body: {TravelId: "T0800", Description: "Conformance created", Status: "A", Seats: 1},
    },
    expect: {
      status: 201,
      headers: {location: "{base}" + DEMO + "/TravelSet('T0800')"},
      jsonPath: [{path: "d.Description", equals: "Conformance created"}],
    },
    tags: ["mutating", "odata"],
  },
  {
    id: "write-read-back",
    name: "the created entity is there, carrying the ETag its metadata promises",
    request: {method: "GET", path: `${DEMO}/TravelSet('T0800')`, headers: json},
    expect: {status: 200, headers: {etag: {matches: '^W/"'}},
      jsonPath: [{path: "d.Seats", equals: 1}, {path: "d.__metadata.etag", matches: '^W/"'}]},
    tags: ["mutating", "odata"],
  },
  {
    id: "write-etag-required",
    name: "a write of an entity the model gives an ETag takes If-Match: without it, 428",
    request: {
      method: "MERGE", path: `${DEMO}/TravelSet('T0800')`, csrf: true, headers: writeHeaders,
      body: {Seats: 9},
    },
    expect: {status: 428, jsonPath: [{path: "error.code", equals: "STG/PRECONDITION_REQUIRED"}]},
    tags: ["mutating", "error"],
  },
  {
    id: "write-etag-stale",
    name: "and with a tag that is no longer the row's, 412 and nothing written",
    request: {
      method: "MERGE", path: `${DEMO}/TravelSet('T0800')`, csrf: true,
      headers: {...writeHeaders, "if-match": 'W/"gone"'},
      body: {Seats: 9},
    },
    expect: {status: 412, jsonPath: [{path: "error.code", equals: "STG/ETAG_MISMATCH"}]},
    tags: ["mutating", "error"],
  },
  {
    id: "write-etag-unchanged",
    name: "so the refused write left the row as it was",
    request: {method: "GET", path: `${DEMO}/TravelSet('T0800')`, headers: json},
    expect: {status: 200, jsonPath: [{path: "d.Seats", equals: 1}]},
    tags: ["mutating", "odata"],
  },
  {
    id: "write-update",
    name: "PUT with If-Match changes it, and answers 204",
    request: {
      method: "PUT", path: `${DEMO}/TravelSet('T0800')`, csrf: true,
      headers: {...writeHeaders, "if-match": "*"},
      body: {d: {Description: "Conformance updated", Status: "X", Seats: 2}},
    },
    expect: {status: 204},
    tags: ["mutating", "odata"],
  },
  {
    id: "write-read-updated",
    name: "the change is what the next read sees",
    request: {method: "GET", path: `${DEMO}/TravelSet('T0800')`, headers: json},
    expect: {status: 200, jsonPath: [{path: "d.Description", equals: "Conformance updated"}, {path: "d.Seats", equals: 2}]},
    tags: ["mutating", "odata"],
  },
  {
    id: "write-duplicate-is-400",
    name: "creating a key that exists is a business error, not a crash",
    request: {
      method: "POST", path: `${DEMO}/TravelSet`, csrf: true, headers: writeHeaders,
      body: {TravelId: "T0001"},
    },
    expect: {status: 400, jsonPath: [{path: "error.code", matches: "BUSINESS"}]},
    tags: ["mutating", "error"],
  },
  {
    id: "write-delete",
    name: "DELETE with If-Match removes it, and the read after is a 404",
    request: {method: "DELETE", path: `${DEMO}/TravelSet('T0800')`, csrf: true, headers: {"if-match": "*"}},
    expect: {status: 204},
    tags: ["mutating", "odata"],
  },
  {
    id: "write-gone",
    name: "and the tree is as it was",
    request: {method: "GET", path: `${DEMO}/TravelSet('T0800')`, headers: json},
    expect: {status: 404},
    tags: ["mutating", "odata"],
  },
  {
    id: "write-deep-insert",
    name: "a deep insert: a travel with its bookings in one POST",
    request: {
      method: "POST", path: `${DEMO}/TravelSet`, csrf: true, headers: writeHeaders,
      body: {
        TravelId: "T0801", Description: "Conformance deep", Status: "A", Seats: 1,
        to_Bookings: [{BookingId: "B001", Customer: "Barbara Liskov"}],
      },
    },
    expect: {status: 201, jsonPath: [{path: "d.to_Bookings.results[0].Customer", equals: "Barbara Liskov"}]},
    tags: ["mutating", "nav"],
  },
  {
    id: "write-deep-insert-children",
    name: "and the children are below the parent afterwards",
    request: {method: "GET", path: `${DEMO}/TravelSet('T0801')/to_Bookings`, headers: json},
    expect: {status: 200, jsonPath: [{path: "d.results", length: 1}]},
    tags: ["mutating", "nav"],
  },
  {
    id: "write-deep-insert-cleanup",
    name: "the deep insert is taken back out",
    request: {method: "DELETE", path: `${DEMO}/TravelSet('T0801')`, csrf: true, headers: {"if-match": "*"}},
    expect: {status: 204},
    tags: ["mutating", "nav"],
  },
  {
    id: "write-batch",
    name: "$batch: a retrieve part and a changeset that creates and deletes",
    request: {
      method: "POST", path: `${DEMO}/$batch`, csrf: true,
      headers: {"content-type": "multipart/mixed; boundary=b"},
      body: [
        "--b", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
        "GET TravelSet?$top=2&$inlinecount=allpages HTTP/1.1", "Accept: application/json", "", "",
        "--b", "Content-Type: multipart/mixed; boundary=cs", "",
        "--cs", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
        "POST TravelSet HTTP/1.1", "Content-Type: application/json", "",
        JSON.stringify({TravelId: "T0802", Description: "via batch", Seats: 1}),
        "--cs", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
        "DELETE TravelSet('T0802') HTTP/1.1", "If-Match: *", "", "",
        "--cs--", "", "--b--", "",
      ].join("\r\n"),
    },
    expect: {
      status: 202,
      contentType: "multipart/mixed",
      contains: ["HTTP/1.1 200 OK", '"__count":"2"', "HTTP/1.1 201 Created", "HTTP/1.1 204 No Content"],
    },
    tags: ["mutating", "batch"],
  },
  {
    id: "write-refused-by-the-model",
    name: "a set the model does not allow to be written is 405, before any DPC method",
    request: {
      method: "POST", path: `${CUBE}/ZC_STG_FLIGHTCUBE`, csrf: true, headers: writeHeaders, body: {},
    },
    expect: {status: 405, jsonPath: [{path: "error.message.value", matches: "not creatable"}]},
    tags: ["mutating", "error", "cds"],
  },
];

export default cases;
