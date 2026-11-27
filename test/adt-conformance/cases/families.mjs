// The families an ABAP-FS user missed (docs/abapfs-conformance.md): function
// groups and their parts, message classes, the main programs of an include,
// the program and include creation preflights, where-used, and the core
// discovery form a client parses. Fixtures are the $ZOSD_TEST package
// (src/zosd_test/src: ZOSD_TEST_FG with three modules, ZOSD_TEST_MSG with
// two messages, ZOSD_TEST_DEMO_INC reached by ZOSD_TEST_DEMO_PROG, and
// ZCL_ZOSD_TEST_DEMO implementing ZIF_ZOSD_TEST_GREETER). The cross-reference
// cases read D010INC and WBCROSSGT, which every host seeds from the tree
// (tools/osd-xref-seed.mjs; osgo at build time).
const NS = {
  group: 'http://www.sap.com/adt/functions/groups', fmodule: 'http://www.sap.com/adt/functions/fmodules',
  mc: 'http://www.sap.com/adt/MessageClass', usageReferences: 'http://www.sap.com/adt/ris/usageReferences',
  asx: 'http://www.sap.com/abapxml'};
const fugr = '/functions/groups/zosd_test_fg';
const text = /text\/plain/;
// every collection of discovery sits in a workspace of its own in the core
// form (ZCL_OSD_ADT_DISCOVERY=>DOCUMENT iv_core): as many workspaces as
// collections, so a reader that takes app:collection as one element per
// workspace (abap-adt-api adtCoreDiscovery) parses it. The count is the
// collections table of ZCL_OSD_ADT_DISCOVERY; a new collection moves it.
const collections = 28;
const validation = (path, query) => ({method: 'POST', path, query});
export default [
  {id: 'F1-fugr-document', point: 'F1', title: 'Function group document with its parts linked', request: {path: fugr},
    expect: {status: 200, contentType: /application\/vnd\.sap\.adt\.functions\.groups\.v2\+xml/, namespaces: NS,
      xml: [{xpath: '/group:abapFunctionGroup/@adtcore:name', value: 'ZOSD_TEST_FG'}, {xpath: '/group:abapFunctionGroup/@adtcore:type', value: 'FUGR/F'},
        {xpath: '/group:abapFunctionGroup/@abapsource:sourceUri', value: 'source/main'}],
      body: /href="fmodules\/z_osd_test_status_text"[\s\S]*href="fmodules\/z_osd_test_item_list"[\s\S]*href="fmodules\/z_osd_test_local_only"/}},
  {id: 'F2-fugr-source', point: 'F2', title: 'Function group source is its main program', request: {path: fugr + '/source/main'},
    expect: {status: 200, contentType: text, body: /INCLUDE lzosd_test_fgtop\./}},
  {id: 'F3-fmodule-document', point: 'F3', title: 'Function module document with its processing type', request: {path: fugr + '/fmodules/z_osd_test_status_text'},
    expect: {status: 200, contentType: /application\/vnd\.sap\.adt\.functions\.fmodules\.v3\+xml/, namespaces: NS,
      xml: [{xpath: '/fmodule:abapFunctionModule/@adtcore:name', value: 'Z_OSD_TEST_STATUS_TEXT'}, {xpath: '/fmodule:abapFunctionModule/@adtcore:type', value: 'FUGR/FF'},
        {xpath: '/fmodule:abapFunctionModule/@fmodule:processingType', value: 'rfc'},
        {xpath: '/fmodule:abapFunctionModule/adtcore:containerRef/@adtcore:name', value: 'ZOSD_TEST_FG'}]}},
  {id: 'F4-fmodule-source', point: 'F4', title: 'Function module source', request: {path: fugr + '/fmodules/z_osd_test_status_text/source/main'},
    expect: {status: 200, contentType: text, body: /^FUNCTION z_osd_test_status_text\./}},
  {id: 'F5-fugr-include-source', point: 'F5', title: 'Function group include source', request: {path: fugr + '/includes/lzosd_test_fgtop/source/main'},
    expect: {status: 200, contentType: text, body: /FUNCTION-POOL zosd_test_fg\./}},
  {id: 'F6-fmodule-missing', point: 'F6', title: 'A module the group does not have is a 404', request: {path: fugr + '/fmodules/z_osd_test_nope'},
    expect: {status: 404, body: /FUGR\/FF Z_OSD_TEST_NOPE does not exist/}},
  {id: 'F7-fugr-tree', point: 'F7', title: 'The tree lists a function group\'s modules and includes',
    request: {method: 'POST', path: '/repository/nodestructure', query: {parent_name: 'ZOSD_TEST_FG', parent_type: 'FUGR/F', withShortDescriptions: 'true'}},
    expect: {status: 200, namespaces: NS, xml: [{xpath: '/asx:abap/asx:values/DATA/TREE_CONTENT', regexp: /^[\s\S]*$/}],
      body: /<OBJECT_TYPE>FUGR\/FF<\/OBJECT_TYPE><OBJECT_NAME>Z_OSD_TEST_STATUS_TEXT<\/OBJECT_NAME>[\s\S]*<OBJECT_TYPE>FUGR\/I<\/OBJECT_TYPE><OBJECT_NAME>LZOSD_TEST_FGTOP<\/OBJECT_NAME>/}},
  {id: 'M1-messageclass-document', point: 'M1', title: 'Message class document with its messages', request: {path: '/messageclass/zosd_test_msg'},
    expect: {status: 200, contentType: /application\/vnd\.sap\.adt\.mc\.messageclass\+xml/, namespaces: NS,
      xml: [{xpath: '/mc:messageClass/@adtcore:name', value: 'ZOSD_TEST_MSG'}, {xpath: '/mc:messageClass/@adtcore:type', value: 'MSAG/N'},
        {xpath: '/mc:messageClass/mc:messages/@mc:msgno', value: ['001', '002']},
        {xpath: '/mc:messageClass/mc:messages[@mc:msgno="001"]/@mc:msgtext', value: 'Demo item &1 was not found'}]}},
  {id: 'M2-messageclass-text', point: 'M2', title: 'Message class as text, one message per line', request: {path: '/messageclass/zosd_test_msg/source/main'},
    expect: {status: 200, contentType: text, body: /^001 Demo item &1 was not found\n002 Demo item &1 has status &2\n$/}},
  {id: 'I1-include-mainprograms', point: 'I1', title: 'The main program of an include, out of D010INC', request: {path: '/programs/includes/zosd_test_demo_inc/mainprograms'},
    expect: {status: 200, contentType: /application\/vnd\.sap\.adt\.programs\.includes\.mainprograms\+xml/,
      xml: [{xpath: '/adtcore:objectReferences/adtcore:objectReference/@adtcore:name', value: 'ZOSD_TEST_DEMO_PROG'},
        {xpath: '/adtcore:objectReferences/adtcore:objectReference/@adtcore:type', value: 'PROG/P'},
        {xpath: '/adtcore:objectReferences/adtcore:objectReference/@adtcore:uri', value: '/sap/bc/adt/programs/programs/zosd_test_demo_prog'},
        {xpath: '/adtcore:objectReferences/adtcore:objectReference/@adtcore:packageName', value: '$ZOSD_TEST_SRC'}]}},
  {id: 'N1-program-validation', point: 'N1', title: 'A new program name passes the wizard preflight',
    request: validation('/programs/validation', {objtype: 'PROG/P', objname: 'ZOSD_KIT_NEW_PROG', packagename: '$TMP'}),
    expect: {status: 200, contentType: /application\/vnd\.sap\.as\+xml/, body: /<CHECK_RESULT>X<\/CHECK_RESULT><SEVERITY>SUCCESS<\/SEVERITY>/}},
  {id: 'N2-program-validation-exists', point: 'N2', title: 'An existing program name is refused with the reason',
    request: validation('/programs/validation', {objtype: 'PROG/P', objname: 'ZOSD_TEST_DEMO_PROG', packagename: '$TMP'}),
    expect: {status: 200, body: /<SEVERITY>ERROR<\/SEVERITY><SHORT_TEXT>PROG ZOSD_TEST_DEMO_PROG already exists<\/SHORT_TEXT>/}},
  {id: 'N3-include-validation-resource', point: 'N3', title: 'The include preflight refuses a program type',
    request: validation('/includes/validation', {objtype: 'PROG/P', objname: 'ZOSD_KIT_NEW_INC', packagename: '$TMP'}),
    expect: {status: 200, body: /<SEVERITY>ERROR<\/SEVERITY><SHORT_TEXT>Object type does not match the validation resource<\/SHORT_TEXT>/}},
  {id: 'U1-whereused-interface', point: 'U1', title: 'Where-used names the class implementing the interface',
    request: {method: 'POST', path: '/repository/informationsystem/usageReferences', query: {uri: '/sap/bc/adt/oo/interfaces/zif_zosd_test_greeter'},
      headers: {'content-type': 'application/*'},
      body: '<?xml version="1.0" encoding="ASCII"?><usagereferences:usageReferenceRequest xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences"><usagereferences:affectedObjects/></usagereferences:usageReferenceRequest>'},
    expect: {status: 200, contentType: /application\/vnd\.sap\.adt\.repository\.usagereferences\.result\.v1\+xml/, namespaces: NS,
      xml: [{xpath: '/usageReferences:usageReferenceResult/usageReferences:referencedObjects/usageReferences:referencedObject/@isResult', value: 'true'},
        {xpath: '/usageReferences:usageReferenceResult/usageReferences:referencedObjects/usageReferences:referencedObject/usageReferences:adtObject/@adtcore:name', regexp: /^[A-Z0-9_\/]+$/}],
      // the fixture class implements the interface: its object, type and package
      body: /<usageReferences:adtObject adtcore:uri="\/sap\/bc\/adt\/oo\/classes\/zcl_zosd_test_demo" adtcore:type="CLAS\/OC" adtcore:name="ZCL_ZOSD_TEST_DEMO"[^>]*>\s*<adtcore:packageRef adtcore:name="\$ZOSD_TEST_SRC"/}},
  {id: 'U2-whereused-missing', point: 'U2', title: 'Where-used of an object that is not there is a 404',
    request: {method: 'POST', path: '/repository/informationsystem/usageReferences', query: {uri: '/sap/bc/adt/oo/classes/zcl_zosd_kit_nobody'}, headers: {'content-type': 'application/*'}, body: ''},
    expect: {status: 404, body: /CLAS ZCL_ZOSD_KIT_NOBODY does not exist/}},
  {id: 'G1-core-discovery-form', point: 'G1', title: 'Core discovery holds one collection per workspace', request: {path: '/core/discovery'},
    expect: {status: 200, xml: [{xpath: '/app:service/app:workspace', count: collections}, {xpath: '/app:service/app:workspace/app:collection', count: collections}]}},
  {id: 'G2-discovery-grouped', point: 'G2', title: 'Discovery keeps every collection, grouped by workspace', request: {path: '/discovery'},
    expect: {status: 200, xml: [{xpath: '/app:service/app:workspace/app:collection', count: collections}]}},
];
