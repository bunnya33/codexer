package relay

import "strconv"

// Match the shared Zod parser: strip unknown object fields, preserve record
// fields, and apply browser string limits in UTF-16 units.
func projectProtocol(schema M, value any) {
	if projectProtocolAt(schema, value, "") != nil {
		fail(400, "invalid-message")
	}
}
func projectProtocolAt(schema M, value any, path string) *logIssue {
	for _, union := range []string{"oneOf", "anyOf"} {
		if choices, ok := schema[union].([]any); ok {
			for _, choice := range choices {
				branch := obj(choice)
				if protocolShape(branch, value) {
					return projectProtocolAt(branch, value, path)
				}
			}
			return nil
		}
	}
	if text, ok := value.(string); ok {
		n := jsLength(text)
		if v, ok := schema["maxLength"]; ok && int64(n) > num(v) {
			return &logIssue{path, "maxLength:" + strconv.FormatInt(num(v), 10)}
		}
		if v, ok := schema["minLength"]; ok && int64(n) < num(v) {
			return &logIssue{path, "minLength:" + strconv.FormatInt(num(v), 10)}
		}
	}
	if values, ok := value.([]any); ok {
		if item, ok := schema["items"].(map[string]any); ok {
			for i, v := range values {
				if issue := projectProtocolAt(item, v, path+"/"+strconv.Itoa(i)); issue != nil {
					return issue
				}
			}
		}
	}
	if values, ok := value.(map[string]any); ok {
		properties, object := schema["properties"].(map[string]any)
		extra, record := schema["additionalProperties"].(map[string]any)
		for key, v := range values {
			if property, ok := properties[key]; ok {
				if issue := projectProtocolAt(obj(property), v, path+safeLogPath([]string{key})); issue != nil {
					return issue
				}
			} else if record {
				if issue := projectProtocolAt(extra, v, path+"/*"); issue != nil {
					return issue
				}
			} else if object {
				delete(values, key)
			}
			if names, ok := schema["propertyNames"].(map[string]any); ok {
				if issue := projectProtocolAt(names, key, path+"/*"); issue != nil {
					return issue
				}
			}
		}
	}
	return nil
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
