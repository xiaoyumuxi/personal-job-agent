import Foundation
import Security
// One JSON message on stdin; secret values never appear in argv or error output.
func output(_ value: Any) { let d = try! JSONSerialization.data(withJSONObject: value); FileHandle.standardOutput.write(d) }
do {
    let raw = FileHandle.standardInput.readDataToEndOfFile()
    guard let req = try JSONSerialization.jsonObject(with: raw) as? [String: Any],
          let service = req["service"] as? String, let account = req["account"] as? String,
          let op = req["op"] as? String else { output(["error":"invalid_input"]); exit(2) }
    let query: [String:Any] = [kSecClass as String:kSecClassGenericPassword, kSecAttrService as String:service, kSecAttrAccount as String:account]
    if op == "get" {
        var q=query; q[kSecReturnData as String]=true; q[kSecMatchLimit as String]=kSecMatchLimitOne
        var result: CFTypeRef?
        let status=SecItemCopyMatching(q as CFDictionary,&result)
        if status == errSecItemNotFound { output(["found":false]); exit(0) }
        guard status == errSecSuccess, let d=result as? Data else { output(["error":"keychain_unavailable","status":status]);exit(3) }
        output(["found":true,"value":String(data:d,encoding:.utf8)!])
    } else if op == "set", let value=req["value"] as? String {
        let d=value.data(using:.utf8)!
        var status=SecItemUpdate(query as CFDictionary,[kSecValueData as String:d] as CFDictionary)
        if status == errSecItemNotFound { var q=query; q[kSecValueData as String]=d; q[kSecAttrAccessible as String]=kSecAttrAccessibleWhenUnlockedThisDeviceOnly; status=SecItemAdd(q as CFDictionary,nil) }
        guard status == errSecSuccess else { output(["error":"keychain_unavailable","status":status]);exit(3) }
        output(["ok":true])
    } else if op == "delete" {
        let status=SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {output(["error":"keychain_unavailable"]);exit(3)}
        output(["ok":true])
    } else { output(["error":"invalid_operation"]);exit(2) }
} catch { output(["error":"keychain_unavailable"]);exit(3) }
