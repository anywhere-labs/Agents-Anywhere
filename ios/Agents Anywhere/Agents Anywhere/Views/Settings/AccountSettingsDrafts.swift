import PhotosUI
import SwiftUI

/// Drafts belong to the settings sheet so native Back and swipe-back preserve
/// edits when a destination leaves the navigation stack.
struct AccountSettingsDrafts {
    var nickname = AccountIdentityDraft()
    var email = AccountIdentityDraft()
    var password = AccountPasswordDraft()
    var avatar = AccountAvatarDraft()

    var hasChanges: Bool {
        nickname.hasChanges || email.hasChanges || password.hasChanges || avatar.hasChanges
    }
    var isWorking: Bool { nickname.isWorking || email.isWorking }
}

struct AccountIdentityDraft {
    var text = ""
    var initialText = ""
    var code = ""
    var didInitialize = false
    var isWorking = false
    var hasChanges: Bool { text != initialText || !code.isEmpty }
}

struct AccountPasswordDraft {
    var password = ""
    var confirmation = ""
    var hasChanges: Bool { !password.isEmpty || !confirmation.isEmpty }
}

struct AccountAvatarDraft {
    var selectedItem: PhotosPickerItem?
    var selectedImage: UIImage?
    var zoom: CGFloat = 1
    var offset = CGSize.zero
    var hasChanges: Bool { selectedItem != nil || selectedImage != nil }
}
