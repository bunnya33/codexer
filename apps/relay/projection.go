package relay

// Match the shared Zod parser: strip unknown object fields, preserve record
// fields, and apply browser string limits in UTF-16 units.
func projectProtocol(schema M, value any) {
	for _, union := range []string{"oneOf", "anyOf"} {
		if choices, ok := schema[union].([]any); ok {
			for _, choice := range choices {
				branch := obj(choice)
				if protocolShape(branch, value) {
					projectProtocol(branch, value)
					return
				}
			}
			return
		}
	}
	if text, ok := value.(string); ok {
		n := jsLength(text)
		if v, ok := schema["maxLength"]; ok && int64(n) > num(v) {
			fail(400, "invalid-message")
		}
		if v, ok := schema["minLength"]; ok && int64(n) < num(v) {
			fail(400, "invalid-message")
		}
	}
	if values, ok := value.([]any); ok {
		if item, ok := schema["items"].(map[string]any); ok {
			for _, v := range values {
				projectProtocol(item, v)
			}
		}
	}
	if values, ok := value.(map[string]any); ok {
		properties, object := schema["properties"].(map[string]any)
		extra, record := schema["additionalProperties"].(map[string]any)
		for key, v := range values {
			if property, ok := properties[key]; ok {
				projectProtocol(obj(property), v)
			} else if record {
				projectProtocol(extra, v)
			} else if object {
				delete(values, key)
			}
			if names, ok := schema["propertyNames"].(map[string]any); ok {
				projectProtocol(names, key)
			}
		}
	}
}
func protocolShape(schema M, value any) bool {
	if constant, ok := schema["const"]; ok && js(constant) != js(value) {
		return false
	}
	switch schema["type"] {
	case "null":
		return value == nil
	case "object":
		m, ok := value.(map[string]any)
		if !ok {
			return false
		}
		for key, raw := range obj(schema["properties"]) {
			property := obj(raw)
			if c, ok := property["const"]; ok && js(m[key]) != js(c) {
				return false
			}
		}
	case "string":
		_, ok := value.(string)
		return ok
	case "array":
		_, ok := value.([]any)
		return ok
	case "number", "integer":
		switch value.(type) {
		case float64, int, int64:
			return true
		}
		return false
	case "boolean":
		_, ok := value.(bool)
		return ok
	}
	return true
}
