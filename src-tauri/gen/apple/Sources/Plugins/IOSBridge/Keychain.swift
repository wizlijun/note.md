import Foundation
import Security
import Tauri

private func service() -> String { "com.bruce.mdeditor.vault" }

private func baseQuery(account: String) -> [String: Any] {
    return [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service(),
        kSecAttrAccount as String: account,
    ]
}

private func upsert(account: String, value: String) throws {
    let data = value.data(using: .utf8) ?? Data()
    SecItemDelete(baseQuery(account: account) as CFDictionary)

    var attrs = baseQuery(account: account)
    attrs[kSecValueData as String] = data
    attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    let status = SecItemAdd(attrs as CFDictionary, nil)
    if status != errSecSuccess {
        throw NSError(domain: "Keychain", code: Int(status), userInfo: nil)
    }
}

private func fetch(account: String) throws -> String? {
    var query = baseQuery(account: account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)

    if status == errSecItemNotFound { return nil }
    if status != errSecSuccess {
        throw NSError(domain: "Keychain", code: Int(status), userInfo: nil)
    }
    guard let data = item as? Data, let s = String(data: data, encoding: .utf8) else { return nil }
    return s
}

private func remove(account: String) throws {
    let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
    if status != errSecSuccess && status != errSecItemNotFound {
        throw NSError(domain: "Keychain", code: Int(status), userInfo: nil)
    }
}

class KeychainPlugin: Plugin {
    @objc public func set(_ invoke: Invoke) throws {
        struct Args: Decodable { let account: String; let value: String }
        let a = try invoke.parseArgs(Args.self)
        do { try upsert(account: a.account, value: a.value); invoke.resolve() }
        catch { invoke.reject("keychain set failed: \(error)") }
    }

    @objc public func get(_ invoke: Invoke) throws {
        struct Args: Decodable { let account: String }
        let a = try invoke.parseArgs(Args.self)
        do {
            if let v = try fetch(account: a.account) {
                invoke.resolve(["value": v])
            } else {
                invoke.resolve(["value": NSNull()])
            }
        } catch { invoke.reject("keychain get failed: \(error)") }
    }

    @objc public func delete(_ invoke: Invoke) throws {
        struct Args: Decodable { let account: String }
        let a = try invoke.parseArgs(Args.self)
        do { try remove(account: a.account); invoke.resolve() }
        catch { invoke.reject("keychain delete failed: \(error)") }
    }

    @objc public func markExcludedFromBackup(_ invoke: Invoke) throws {
        struct Args: Decodable { let path: String }
        let a = try invoke.parseArgs(Args.self)
        var url = URL(fileURLWithPath: a.path)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        do {
            try url.setResourceValues(values)
            invoke.resolve()
        } catch {
            invoke.reject("exclude from backup failed: \(error)")
        }
    }
}

@_cdecl("init_plugin_keychain")
func initPluginKeychain() -> Plugin { return KeychainPlugin() }
