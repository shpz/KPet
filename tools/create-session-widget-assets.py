"""使用 UE 5.8 Editor Python 生成会话面板的两个 UMG Blueprint。

默认行为是只做 API 自查，不创建或修改资产。生成资产时必须在 UnrealEditor
命令行显式加入 ``-SessionWidgetGenerate``。这样可以在 C++ 父类尚未编译时安全
运行探针，也方便后续重复执行生成流程。

推荐调用：

    UnrealEditor-Cmd.exe Pet.uproject -run=pythonscript \
        -script=tools/create-session-widget-assets.py \
        -unattended -nop4 -nosplash -nullrhi \
        -EnablePlugins=PythonScriptPlugin -SessionWidgetGenerate

脚本只会删除并重建以下两个明确的目标资产：

    /Game/UI/WBP_PetSessionPanel
    /Game/UI/WBP_PetSessionRow

不创建伪造的二进制文件；最终 ``uasset`` 由 Unreal Editor 序列化生成。
"""

import sys

import unreal


LOG_PREFIX = "会话面板资产"
PANEL_CLASS_PATH = "/Script/Pet.PetSessionPanelWidget"
ROW_CLASS_PATH = "/Script/Pet.PetSessionRowWidget"
UI_PACKAGE_PATH = "/Game/UI"
PANEL_ASSET_NAME = "WBP_PetSessionPanel"
ROW_ASSET_NAME = "WBP_PetSessionRow"
PAWN_BLUEPRINT_PATH = "/Game/Blueprints/BP_PetCapturePawn"
PANEL_GENERATED_CLASS_PATH = "/Game/UI/WBP_PetSessionPanel.WBP_PetSessionPanel_C"


def log(message):
    unreal.log("{}：{}".format(LOG_PREFIX, message))


def log_warning(message):
    unreal.log_warning("{}：{}".format(LOG_PREFIX, message))


def log_error(message):
    unreal.log_error("{}：{}".format(LOG_PREFIX, message))


def _safe_class(name):
    value = getattr(unreal, name, None)
    if value is None:
        log_warning("缺少反射类型 {}".format(name))
    return value


def _safe_get_editor_property(obj, property_name):
    try:
        return obj.get_editor_property(property_name)
    except Exception as error:
        log_warning("读取 {} 的属性 {} 失败：{}".format(obj, property_name, error))
        return None


def _safe_set_editor_property(obj, property_name, value, required=False):
    try:
        obj.set_editor_property(property_name, value)
        return True
    except Exception as error:
        message = "设置 {} 的属性 {} 失败：{}".format(obj, property_name, error)
        if required:
            log_error(message)
        else:
            log_warning(message)
        return False


def _safe_new_widget(widget_class, widget_tree, name):
    """使用 UE 5.8 已验证的 new_object 参数形式构造 Widget。"""
    if widget_class is None:
        return None
    try:
        # UE 5.8 的 Python 绑定参数名是 type；保留 base_type 仅用于旧版
        # 绑定兼容，避免把探针时期的错误参数带入正式生成流程。
        return unreal.new_object(type=widget_class, outer=widget_tree, name=name)
    except Exception as error:
        try:
            return unreal.new_object(base_type=widget_class, outer=widget_tree, name=name)
        except Exception:
            log_error("构造控件 {} 失败：{}".format(name, error))
            return None


def _add_child(parent, child):
    if parent is None or child is None:
        return None
    try:
        return parent.add_child(child)
    except Exception as error:
        log_error("向 {} 添加 {} 失败：{}".format(parent, child, error))
        return None


def _margin(left, top, right, bottom):
    margin_type = getattr(unreal, "Margin", None)
    if margin_type is None:
        return None
    # UE 5.8 的绑定通常支持位置参数；关键字形式作为兼容回退。
    try:
        return margin_type(left, top, right, bottom)
    except Exception:
        try:
            return margin_type(
                left=left,
                top=top,
                right=right,
                bottom=bottom,
            )
        except Exception as error:
            log_warning("构造边距失败：{}".format(error))
            return None


def _set_padding(slot_or_widget, left, top, right, bottom):
    value = _margin(left, top, right, bottom)
    if value is not None:
        _safe_set_editor_property(slot_or_widget, "padding", value)


def _set_text(widget, value):
    text_type = getattr(unreal, "Text", None)
    if text_type is None:
        log_warning("缺少 unreal.Text，控件 {} 保留默认文本".format(widget))
        return
    try:
        text_value = text_type(value)
    except Exception as error:
        log_warning("构造文本失败：{}".format(error))
        return
    _safe_set_editor_property(widget, "text", text_value)


def _set_color(widget, property_name, red, green, blue, alpha=1.0):
    color_type = getattr(unreal, "LinearColor", None)
    if color_type is None:
        log_warning("缺少 unreal.LinearColor，控件 {} 使用默认颜色".format(widget))
        return
    try:
        color = color_type(red, green, blue, alpha)
    except Exception as error:
        log_warning("构造颜色失败：{}".format(error))
        return
    value = color
    if property_name == "color_and_opacity":
        slate_color_type = getattr(unreal, "SlateColor", None)
        if slate_color_type is not None:
            try:
                value = slate_color_type()
                value.set_editor_property("specified_color", color)
            except Exception as error:
                log_warning("构造 SlateColor 失败：{}".format(error))
                value = color
    _safe_set_editor_property(widget, property_name, value)


def _set_visibility(widget, visible):
    value_name = "VISIBLE" if visible else "COLLAPSED"
    value = _enum_value("ESlateVisibility", value_name)
    if value is not None:
        _safe_set_editor_property(widget, "visibility", value)


def _set_alignment(widget, horizontal=None, vertical=None):
    if horizontal is not None:
        value = _enum_value("EHorizontalAlignment", horizontal)
        if value is not None:
            _safe_set_editor_property(widget, "horizontal_alignment", value)
    if vertical is not None:
        value = _enum_value("EVerticalAlignment", vertical)
        if value is not None:
            _safe_set_editor_property(widget, "vertical_alignment", value)


def _set_font_size(widget, size):
    font = _safe_get_editor_property(widget, "font")
    if font is None:
        return
    if not _safe_set_editor_property(font, "size", size):
        return
    _safe_set_editor_property(widget, "font", font)


def _set_slot_fill(slot):
    """尽量让列表占据主体空间；属性缺失时不影响资产生成。"""
    if slot is None:
        return
    size_type = getattr(unreal, "SlateChildSize", None)
    rule_type = getattr(unreal, "ESlateSizeRule", None) or getattr(unreal, "SlateSizeRule", None)
    if size_type is None or rule_type is None:
        return
    try:
        size = size_type()
        rule = getattr(rule_type, "FILL", None)
        if rule is not None:
            _safe_set_editor_property(size, "size_rule", rule)
        _safe_set_editor_property(size, "value", 1.0)
        _safe_set_editor_property(slot, "size", size)
    except Exception as error:
        log_warning("设置填充布局失败：{}".format(error))


def _compile_blueprint(blueprint):
    utilities = getattr(unreal, "KismetEditorUtilities", None)
    compile_method = getattr(utilities, "compile_blueprint", None) if utilities else None
    if compile_method is None:
        utilities = getattr(unreal, "BlueprintEditorLibrary", None)
        compile_method = getattr(utilities, "compile_blueprint", None) if utilities else None
    if compile_method is None:
        log_warning("当前 Python 绑定没有 KismetEditorUtilities.compile_blueprint，跳过显式编译")
        return
    try:
        compile_method(blueprint)
        log("已编译 {}".format(blueprint.get_name()))
    except Exception as error:
        log_warning("编译 {} 失败：{}".format(blueprint.get_name(), error))


def _generated_class(blueprint):
    library = getattr(unreal, "EditorAssetLibrary", None)
    load_method = getattr(library, "load_blueprint_class", None) if library else None
    if load_method is not None:
        try:
            package_path = blueprint.get_path_name().split(".", 1)[0]
            loaded_class = load_method(package_path)
            if loaded_class is not None:
                return loaded_class
        except Exception as error:
            log_warning("load_blueprint_class 失败：{}".format(error))
    return _safe_get_editor_property(blueprint, "generated_class")


def _widget_tree(blueprint):
    helper_type = _safe_class("PetSessionWidgetAssetLibrary")
    method = getattr(helper_type, "get_widget_tree", None) if helper_type else None
    if method is None:
        log_error("缺少 Editor-only WidgetTree 访问辅助函数")
        return None
    try:
        return method(blueprint)
    except Exception as error:
        log_error("取得 WidgetTree 失败：{}".format(error))
        return None


def _set_root_widget(blueprint, root_widget):
    helper_type = _safe_class("PetSessionWidgetAssetLibrary")
    method = getattr(helper_type, "set_root_widget", None) if helper_type else None
    if method is None:
        log_error("缺少 Editor-only RootWidget 写入辅助函数")
        return False
    try:
        return bool(method(blueprint, root_widget))
    except Exception as error:
        log_error("设置 RootWidget 失败：{}".format(error))
        return False


def _load_required_class(path, display_name, required=True):
    try:
        value = unreal.load_class(None, path)
    except Exception as error:
        if required:
            log_error("加载{} {} 失败：{}".format(display_name, path, error))
        else:
            log_warning("加载{} {} 失败：{}".format(display_name, path, error))
        return None
    if value is None:
        message = "找不到{} {}；请先完成 C++ 编译".format(display_name, path)
        if required:
            log_error(message)
        else:
            log_warning(message)
    else:
        log("已找到{} {}".format(display_name, path))
    return value


def _asset_exists(path):
    library = getattr(unreal, "EditorAssetLibrary", None)
    method = getattr(library, "does_asset_exist", None) if library else None
    if method is None:
        return False
    try:
        return bool(method(path))
    except Exception as error:
        log_warning("检查资产 {} 失败：{}".format(path, error))
        return False


def _delete_target_asset(path):
    if not _asset_exists(path):
        return True
    library = getattr(unreal, "EditorAssetLibrary", None)
    method = getattr(library, "delete_asset", None) if library else None
    if method is None:
        log_error("缺少 EditorAssetLibrary.delete_asset，无法重建 {}".format(path))
        return False
    try:
        if bool(method(path)):
            log("已删除旧目标资产 {}".format(path))
            return True
    except Exception as error:
        log_error("删除旧目标资产 {} 失败：{}".format(path, error))
        return False
    log_error("删除旧目标资产 {} 未返回成功".format(path))
    return False


def _create_blueprint(asset_name, parent_class):
    factory_type = _safe_class("WidgetBlueprintFactory")
    if factory_type is None:
        return None
    try:
        factory = factory_type()
    except Exception as error:
        log_error("构造 WidgetBlueprintFactory 失败：{}".format(error))
        return None

    if not _safe_set_editor_property(factory, "parent_class", parent_class, required=True):
        return None

    try:
        asset_tools = unreal.AssetToolsHelpers.get_asset_tools()
        blueprint = asset_tools.create_asset(
            asset_name,
            UI_PACKAGE_PATH,
            unreal.WidgetBlueprint,
            factory,
        )
    except Exception as error:
        log_error("创建 {} 失败：{}".format(asset_name, error))
        return None
    if blueprint is None:
        log_error("创建 {} 返回空资产".format(asset_name))
        return None
    log("已创建 Blueprint {}".format(blueprint.get_path_name()))
    return blueprint


def _save_asset(asset):
    library = getattr(unreal, "EditorAssetLibrary", None)
    save_method = getattr(library, "save_loaded_asset", None) if library else None
    if save_method is None:
        log_error("缺少 EditorAssetLibrary.save_loaded_asset，无法保存 {}".format(asset))
        return False
    try:
        result = bool(save_method(asset))
    except Exception as error:
        log_error("保存 {} 失败：{}".format(asset.get_path_name(), error))
        return False
    if result:
        log("已保存 {}".format(asset.get_path_name()))
    else:
        log_error("保存 {} 未返回成功".format(asset.get_path_name()))
    return result


def _configure_pawn_session_panel_class(panel_blueprint):
    """通过 Editor-only C++ 反射把 Panel 软类写入 Pawn Blueprint CDO。"""
    library = getattr(unreal, "EditorAssetLibrary", None)
    load_method = getattr(library, "load_asset", None) if library else None
    if load_method is None:
        log_error("缺少 EditorAssetLibrary.load_asset，无法配置 Pawn CDO")
        return False

    try:
        pawn_blueprint = load_method(PAWN_BLUEPRINT_PATH)
    except Exception as error:
        log_error("加载 Pawn Blueprint {} 失败：{}".format(PAWN_BLUEPRINT_PATH, error))
        return False
    if pawn_blueprint is None:
        log_error("找不到 Pawn Blueprint {}".format(PAWN_BLUEPRINT_PATH))
        return False

    helper_type = _safe_class("PetSessionWidgetAssetLibrary")
    configure_method = getattr(helper_type, "configure_pawn_session_panel_class", None) if helper_type else None
    if configure_method is None:
        log_error("缺少 Editor-only Pawn 软类配置辅助函数")
        return False
    try:
        configured = bool(configure_method(pawn_blueprint, panel_blueprint))
    except Exception as error:
        log_error("配置 Pawn CDO 软类引用失败：{}".format(error))
        return False
    if not configured:
        log_error("C++ 辅助层未能配置 Pawn CDO 软类引用")
        return False
    if not _save_asset(pawn_blueprint):
        return False
    log("已配置并保存 Pawn CDO 软类引用：{} -> {}".format(
        "SessionPanelWidgetClass",
        PANEL_GENERATED_CLASS_PATH,
    ))
    return True


def _make_widget(widget_class, widget_tree, name):
    widget = _safe_new_widget(widget_class, widget_tree, name)
    if widget is None:
        return None
    # new_object 的名称就是 UMG 编辑器中的控件名称，供 BindWidget 使用。
    return widget


def _build_panel(blueprint, row_generated_class):
    widget_tree = _widget_tree(blueprint)
    if widget_tree is None:
        log_error("Panel Blueprint 没有 WidgetTree")
        return False

    border_type = _safe_class("Border")
    vertical_type = _safe_class("VerticalBox")
    horizontal_type = _safe_class("HorizontalBox")
    text_type = _safe_class("TextBlock")
    list_type = _safe_class("ListView")
    if not all((border_type, vertical_type, horizontal_type, text_type, list_type)):
        return False

    root = _make_widget(border_type, widget_tree, "Border_Root")
    body = _make_widget(vertical_type, widget_tree, "VerticalBox")
    header = _make_widget(horizontal_type, widget_tree, "Header")
    title = _make_widget(text_type, widget_tree, "Text_HeaderTitle")
    hint = _make_widget(text_type, widget_tree, "Text_HeaderHint")
    sessions = _make_widget(list_type, widget_tree, "ListView_Sessions")
    empty = _make_widget(text_type, widget_tree, "EmptyState")
    if not all((root, body, header, title, hint, sessions, empty)):
        return False

    _safe_set_editor_property(root, "brush_color", _linear_color(0.035, 0.045, 0.075, 0.98))
    _set_padding(root, 16.0, 14.0, 16.0, 14.0)
    _set_color(title, "color_and_opacity", 0.93, 0.96, 1.0, 1.0)
    _set_color(hint, "color_and_opacity", 0.50, 0.58, 0.70, 1.0)
    _set_color(empty, "color_and_opacity", 0.50, 0.58, 0.70, 1.0)
    _set_text(title, "KimiPet 会话")
    _set_text(hint, "最近会话")
    _set_text(empty, "暂无会话")
    _set_font_size(title, 16)
    _set_font_size(hint, 11)
    _set_font_size(empty, 13)

    _safe_set_editor_property(sessions, "entry_widget_class", row_generated_class, required=True)
    _safe_set_editor_property(sessions, "vertical_entry_spacing", 6.0)
    consume_mode = _enum_value("EConsumeMouseWheel", "WHEN_SCROLLING_POSSIBLE")
    if consume_mode is not None:
        _safe_set_editor_property(sessions, "consume_mouse_wheel", consume_mode)

    if _add_child(root, body) is None:
        return False
    header_slot = _add_child(body, header)
    title_slot = _add_child(header, title)
    hint_slot = _add_child(header, hint)
    sessions_slot = _add_child(body, sessions)
    empty_slot = _add_child(body, empty)
    _set_slot_fill(title_slot)
    _set_slot_fill(sessions_slot)
    _safe_set_editor_property(header_slot, "padding", _margin(0.0, 0.0, 0.0, 4.0))
    _safe_set_editor_property(title_slot, "padding", _margin(0.0, 0.0, 10.0, 0.0))
    _set_alignment(title_slot, vertical="CENTER")
    _set_alignment(hint_slot, horizontal="RIGHT", vertical="CENTER")
    _safe_set_editor_property(sessions_slot, "padding", _margin(0.0, 8.0, 0.0, 4.0))
    _set_alignment(empty_slot, horizontal="CENTER", vertical="CENTER")
    _safe_set_editor_property(empty_slot, "padding", _margin(8.0, 20.0, 8.0, 20.0))
    _safe_set_editor_property(empty, "visibility", _enum_value("ESlateVisibility", "COLLAPSED"))
    if not _set_root_widget(blueprint, root):
        log_error("Panel Blueprint 设置根控件失败")
        return False
    log("已构建 Panel 层级：Border_Root/VerticalBox/Header、ListView_Sessions、EmptyState")
    return True


def _build_row(blueprint):
    widget_tree = _widget_tree(blueprint)
    if widget_tree is None:
        log_error("Row Blueprint 没有 WidgetTree")
        return False

    button_type = _safe_class("Button")
    overlay_type = _safe_class("Overlay")
    border_type = _safe_class("Border")
    text_type = _safe_class("TextBlock")
    horizontal_type = _safe_class("HorizontalBox")
    spacer_type = _safe_class("Spacer")
    if not all((button_type, overlay_type, border_type, text_type, horizontal_type, spacer_type)):
        return False

    button = _make_widget(button_type, widget_tree, "Button_Row")
    overlay = _make_widget(overlay_type, widget_tree, "Overlay")
    background = _make_widget(border_type, widget_tree, "Border_RowBackground")
    active_bar = _make_widget(border_type, widget_tree, "ActiveBar")
    active_bar_spacer = _make_widget(spacer_type, widget_tree, "Spacer_ActiveBar")
    content = _make_widget(horizontal_type, widget_tree, "HorizontalBox_RowContent")
    title = _make_widget(text_type, widget_tree, "Text_Title")
    session_id = _make_widget(text_type, widget_tree, "Text_SessionId")
    working = _make_widget(text_type, widget_tree, "WorkingDots")
    unread = _make_widget(text_type, widget_tree, "UnreadBubble")
    if not all((button, overlay, background, active_bar, active_bar_spacer, content,
                title, session_id, working, unread)):
        return False

    _safe_set_editor_property(background, "brush_color", _linear_color(0.055, 0.070, 0.110, 0.98))
    _safe_set_editor_property(active_bar, "brush_color", _linear_color(0.18, 0.62, 1.0, 1.0))
    _safe_set_editor_property(active_bar_spacer, "size", unreal.Vector2D(3.0, 24.0))
    _set_text(title, "会话标题")
    _set_text(session_id, "短 ID")
    _set_text(working, "...")
    _set_text(unread, "新回复")
    _set_font_size(title, 13)
    _set_font_size(session_id, 10)
    _set_font_size(working, 12)
    _set_font_size(unread, 10)
    _set_color(title, "color_and_opacity", 0.90, 0.94, 1.0, 1.0)
    _set_color(session_id, "color_and_opacity", 0.46, 0.56, 0.70, 1.0)
    _set_color(working, "color_and_opacity", 0.32, 0.72, 1.0, 1.0)
    _set_color(unread, "color_and_opacity", 1.0, 0.72, 0.30, 1.0)
    _set_visibility(working, False)
    _set_visibility(unread, False)

    button_content_slot = _add_child(button, overlay)
    _add_child(overlay, background)
    active_slot = _add_child(overlay, active_bar)
    _add_child(active_bar, active_bar_spacer)
    content_slot = _add_child(overlay, content)
    title_slot = _add_child(content, title)
    session_id_slot = _add_child(content, session_id)
    working_slot = _add_child(content, working)
    unread_slot = _add_child(content, unread)
    _set_alignment(active_slot, horizontal="LEFT", vertical="FILL")
    _set_alignment(button_content_slot, horizontal="FILL", vertical="FILL")
    _set_alignment(content_slot, horizontal="FILL", vertical="CENTER")
    _safe_set_editor_property(content_slot, "padding", _margin(12.0, 4.0, 10.0, 4.0))
    _set_slot_fill(title_slot)
    _set_alignment(title_slot, vertical="CENTER")
    _set_alignment(session_id_slot, vertical="CENTER")
    _set_alignment(working_slot, vertical="CENTER")
    _set_alignment(unread_slot, vertical="CENTER")
    _safe_set_editor_property(session_id_slot, "padding", _margin(8.0, 0.0, 8.0, 0.0))
    _safe_set_editor_property(working_slot, "padding", _margin(3.0, 0.0, 3.0, 0.0))
    _safe_set_editor_property(unread_slot, "padding", _margin(4.0, 0.0, 0.0, 0.0))
    if not _set_root_widget(blueprint, button):
        log_error("Row Blueprint 设置根控件失败")
        return False
    log("已构建 Row 层级：Button_Row/Overlay/背景、ActiveBar、单行会话内容与状态指示器")
    return True


def _linear_color(red, green, blue, alpha):
    color_type = getattr(unreal, "LinearColor", None)
    if color_type is None:
        return None
    try:
        return color_type(red, green, blue, alpha)
    except Exception:
        return None


def _enum_value(type_name, value_name):
    enum_type = getattr(unreal, type_name, None)
    if enum_type is None and type_name.startswith("E"):
        enum_type = getattr(unreal, type_name[1:], None)
    if enum_type is None:
        return None
    candidates = [value_name]
    if type_name == "EHorizontalAlignment":
        candidates.insert(0, "H_ALIGN_{}".format(value_name))
    elif type_name == "EVerticalAlignment":
        candidates.insert(0, "V_ALIGN_{}".format(value_name))
    for candidate in candidates:
        value = getattr(enum_type, candidate, None)
        if value is not None:
            return value
    return None


def _build_standard_animations(blueprint):
    helper_type = _safe_class("PetSessionWidgetAssetLibrary")
    add_method = getattr(helper_type, "add_standard_animations", None) if helper_type else None
    validate_method = getattr(helper_type, "validate_standard_animations", None) if helper_type else None
    if add_method is None or validate_method is None:
        log_error("缺少 Editor-only 动画生成辅助函数；请先完成 PetEditor 编译")
        return False
    try:
        if not bool(add_method(blueprint)):
            log_error("C++ 辅助层未能创建标准动画")
            return False
        if not bool(validate_method(blueprint)):
            log_error("C++ 辅助层创建的动画未通过结构校验")
            return False
    except Exception as error:
        log_error("调用 C++ 动画生成辅助层失败：{}".format(error))
        return False
    log("已写入真实 UWidgetAnimation、MovieScene、控件绑定和透明度轨道")
    return True


def generate_assets():
    panel_class = _load_required_class(PANEL_CLASS_PATH, "Panel 父类")
    row_class = _load_required_class(ROW_CLASS_PATH, "Row 父类")
    if panel_class is None or row_class is None:
        log_error("父类未就绪，停止生成；本次没有创建任何资产")
        return False

    panel_path = "{}/{}".format(UI_PACKAGE_PATH, PANEL_ASSET_NAME)
    row_path = "{}/{}".format(UI_PACKAGE_PATH, ROW_ASSET_NAME)
    # 先删持有 Row 类引用的 Panel，再删 Row，避免加载旧引用时产生错误。
    if not _delete_target_asset(panel_path) or not _delete_target_asset(row_path):
        log_error("无法清理旧目标资产，停止生成")
        return False

    row_blueprint = _create_blueprint(ROW_ASSET_NAME, row_class)
    if row_blueprint is None or not _build_row(row_blueprint):
        log_error("Row Blueprint 生成失败")
        return False
    if not _build_standard_animations(row_blueprint):
        return False
    _compile_blueprint(row_blueprint)
    row_generated_class = _generated_class(row_blueprint)
    if row_generated_class is None:
        log_error("Row Blueprint 没有生成类，停止生成 Panel")
        return False
    if not _save_asset(row_blueprint):
        return False

    panel_blueprint = _create_blueprint(PANEL_ASSET_NAME, panel_class)
    if panel_blueprint is None or not _build_panel(panel_blueprint, row_generated_class):
        log_error("Panel Blueprint 生成失败")
        return False
    if not _build_standard_animations(panel_blueprint):
        return False
    _compile_blueprint(panel_blueprint)
    if not _save_asset(panel_blueprint):
        return False
    if not _configure_pawn_session_panel_class(panel_blueprint):
        return False

    log("两个 UMG Blueprint 已生成并保存")
    return True


def _try_property_names(class_value, names):
    if class_value is None:
        return
    object_value = None
    try:
        object_value = class_value()
    except Exception:
        # 反射类大多不能在 Python 中直接实例化；这里只输出静态绑定能力。
        pass
    for name in names:
        if object_value is None:
            log("API 自查 {}：类型存在，无法构造实例验证属性 {}".format(class_value, name))
            continue
        try:
            object_value.get_editor_property(name)
            log("API 自查 {}：属性 {} 可读".format(class_value, name))
        except Exception as error:
            log_warning("API 自查 {}：属性 {} 不可读：{}".format(class_value, name, error))


def probe_api():
    log("开始 API 自查；默认不会创建或修改资产")
    required_types = [
        "WidgetBlueprintFactory",
        "WidgetBlueprint",
        "WidgetTree",
        "Border",
        "VerticalBox",
        "HorizontalBox",
        "TextBlock",
        "ListView",
        "Button",
        "Overlay",
        "Margin",
        "LinearColor",
        "KismetEditorUtilities",
        "BlueprintEditorLibrary",
        "PetSessionWidgetAssetLibrary",
    ]
    for type_name in required_types:
        value = getattr(unreal, type_name, None)
        if value is None:
            log_warning("API 自查缺少 {}".format(type_name))
        else:
            log("API 自查找到 {}".format(type_name))

    try:
        factory = unreal.WidgetBlueprintFactory()
        _try_property_names(factory, ["parent_class"])
    except Exception as error:
        log_warning("API 自查无法构造 WidgetBlueprintFactory：{}".format(error))

    panel_class = _load_required_class(PANEL_CLASS_PATH, "Panel 父类", required=False)
    row_class = _load_required_class(ROW_CLASS_PATH, "Row 父类", required=False)
    if panel_class is None or row_class is None:
        log("父类尚未全部可加载；这是允许的，等待 C++ 编译完成后再用 -SessionWidgetGenerate")
    log("API 自查结束")
    return True


def _command_line_text():
    pieces = list(sys.argv)
    system_library = getattr(unreal, "SystemLibrary", None)
    get_command_line = getattr(system_library, "get_command_line", None) if system_library else None
    if get_command_line is not None:
        try:
            pieces.append(get_command_line())
        except Exception:
            pass
    return " ".join(str(item) for item in pieces)


def main():
    command_line = _command_line_text()
    if "-SessionWidgetGenerate" not in command_line:
        probe_api()
        return
    log("收到 -SessionWidgetGenerate，开始生成目标资产")
    if not generate_assets():
        raise RuntimeError("会话面板 UMG 资产生成失败")


main()
