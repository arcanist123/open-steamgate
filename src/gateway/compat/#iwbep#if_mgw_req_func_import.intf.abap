INTERFACE /iwbep/if_mgw_req_func_import PUBLIC.
* The technical request context of a function import. Overlay (H5x-3): the
* pinned library leaves the interface empty; the SEGW sample service calls
* get_function_import_name and get_converted_parameters through it
* (io_tech_request_context TYPE REF TO /iwbep/if_mgw_req_func_import in its
* ACTION_SO_ACTIONS, framework-gaps.json of bed run 18 -- private evidence).
* Signatures from the call shape and this runtime's request context, which
* holds the name and the raw parameters the URL carried: the name as text,
* the parameters converted into the structure the provider declares (the
* same conversion the request context does for keys, one component per
* parameter by name).
  METHODS get_function_import_name
    RETURNING
      VALUE(rv_function_import_name) TYPE string.

  METHODS get_converted_parameters
    EXPORTING
      es_parameter_values TYPE data.
ENDINTERFACE.
