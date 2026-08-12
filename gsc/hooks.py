app_name = "gsc"
app_title = "GSC"
app_publisher = "Hicom System"
app_description = "GSC Custom App"
app_email = "h1com.syst3m@gmail.com"
app_license = "mit"

# Apps
# ------------------

# required_apps = []

# Each item in the list will be shown as an app in the apps page
# add_to_apps_screen = [
# 	{
# 		"name": "gsc",
# 		"logo": "/assets/gsc/logo.png",
# 		"title": "GSC",
# 		"route": "/gsc",
# 		"has_permission": "gsc.api.permission.has_app_permission"
# 	}
# ]

# Includes in <head>
# ------------------

# include js, css files in header of desk.html
app_include_css = "/assets/gsc/css/point_of_sale.css"
# app_include_js = "/assets/gsc/js/gsc.js"

# include js, css files in header of web template
# web_include_css = "/assets/gsc/css/gsc.css"
# web_include_js = "/assets/gsc/js/gsc.js"

# include custom scss in every website theme (without file extension ".scss")
# website_theme_scss = "gsc/public/scss/website"

# include js, css files in header of web form
# webform_include_js = {"doctype": "public/js/doctype.js"}
# webform_include_css = {"doctype": "public/css/doctype.css"}

# include js in page
page_js = {"point-of-sale": "public/js/point_of_sale.js"}

# include js in doctype views
doctype_js = {"Laundry Order": "public/js/laundry_order.js"}
doctype_list_js = {"Laundry Order": "public/js/laundry_order_list.js"}
# doctype_tree_js = {"doctype" : "public/js/doctype_tree.js"}
# doctype_calendar_js = {"doctype" : "public/js/doctype_calendar.js"}

# Svg Icons
# ------------------
# include app icons in desk
# app_include_icons = "gsc/public/icons.svg"

# Fixtures
# --------

fixtures = [
	{"dt": "Kanban Board", "filters": [["reference_doctype", "=", "Laundry Order"]]},
]

# Home Pages
# ----------

# application home page (will override Website Settings)
# home_page = "login"

# website user home page (by Role)
# role_home_page = {
# 	"Role": "home_page"
# }

# Generators
# ----------

# automatically create page for each record of this doctype
# website_generators = ["Web Page"]

# automatically load and sync documents of this doctype from downstream apps
# importable_doctypes = [doctype_1]

# Jinja
# ----------

# add methods and filters to jinja environment
# jinja = {
# 	"methods": "gsc.utils.jinja_methods",
# 	"filters": "gsc.utils.jinja_filters"
# }

# Installation
# ------------

# before_install = "gsc.install.before_install"
# after_install = "gsc.install.after_install"

# Uninstallation
# ------------

# before_uninstall = "gsc.uninstall.before_uninstall"
# after_uninstall = "gsc.uninstall.after_uninstall"

# Integration Setup
# ------------------
# To set up dependencies/integrations with other apps
# Name of the app being installed is passed as an argument

# before_app_install = "gsc.utils.before_app_install"
# after_app_install = "gsc.utils.after_app_install"

# Integration Cleanup
# -------------------
# To clean up dependencies/integrations with other apps
# Name of the app being uninstalled is passed as an argument

# before_app_uninstall = "gsc.utils.before_app_uninstall"
# after_app_uninstall = "gsc.utils.after_app_uninstall"

# Build
# ------------------
# To hook into the build process

# after_build = "gsc.build.after_build"

# Desk Notifications
# ------------------
# See frappe.core.notifications.get_notification_config

# notification_config = "gsc.notifications.get_notification_config"

# Permissions
# -----------
# Permissions evaluated in scripted ways

# permission_query_conditions = {
# 	"Event": "frappe.desk.doctype.event.event.get_permission_query_conditions",
# }
#
# has_permission = {
# 	"Event": "frappe.desk.doctype.event.event.has_permission",
# }

# Document Events
# ---------------
# Hook on document methods and events

doc_events = {
	"Sales Invoice": {
		"on_submit": "gsc.overrides.sales_invoice.create_laundry_order",
		# Laundry Order.status is a fetch_from snapshot, not a live view -- it
		# has to be re-pushed whenever the invoice's status moves. Matters only
		# since credit ("Hutang") sales exist. See gsc/overrides/payment_entry.py.
		"on_update_after_submit": "gsc.overrides.payment_entry.sync_from_sales_invoice",
	},
	"Payment Entry": {
		"on_submit": "gsc.overrides.payment_entry.sync_from_payment_entry",
		"on_cancel": "gsc.overrides.payment_entry.sync_from_payment_entry",
	},
}

# Scheduled Tasks
# ---------------

# scheduler_events = {
# 	"all": [
# 		"gsc.tasks.all"
# 	],
# 	"daily": [
# 		"gsc.tasks.daily"
# 	],
# 	"hourly": [
# 		"gsc.tasks.hourly"
# 	],
# 	"weekly": [
# 		"gsc.tasks.weekly"
# 	],
# 	"monthly": [
# 		"gsc.tasks.monthly"
# 	],
# }

# Testing
# -------

# before_tests = "gsc.install.before_tests"

# Extend DocType Class
# ------------------------------
#
# Specify custom mixins to extend the standard doctype controller.
# extend_doctype_class = {
# 	"Task": "gsc.custom.task.CustomTaskMixin"
# }

# Override DocType Class
# ------------------------------
#
# Removes core's POS Opening Entry requirement from POS-screen Sales Invoices:
# GSC runs no cashier shifts, and that same validation is what blocks
# back-dating. See gsc/overrides/sales_invoice.py::GSCSalesInvoice.
override_doctype_class = {
	"Sales Invoice": "gsc.overrides.sales_invoice.GSCSalesInvoice",
}

# Overriding Methods
# ------------------------------
#
override_whitelisted_methods = {
	"erpnext.selling.page.point_of_sale.point_of_sale.get_past_order_list": "gsc.overrides.point_of_sale.get_past_order_list",
}
#
# each overriding function accepts a `data` argument;
# generated from the base implementation of the doctype dashboard,
# along with any modifications made in other Frappe apps
# override_doctype_dashboards = {
# 	"Task": "gsc.task.get_dashboard_data"
# }

# exempt linked doctypes from being automatically cancelled
#
# auto_cancel_exempted_doctypes = ["Auto Repeat"]

# Ignore links to specified DocTypes when deleting documents
# -----------------------------------------------------------

# ignore_links_on_delete = ["Communication", "ToDo"]

# Request Events
# ----------------
# before_request = ["gsc.utils.before_request"]
# after_request = ["gsc.utils.after_request"]

# Job Events
# ----------
# before_job = ["gsc.utils.before_job"]
# after_job = ["gsc.utils.after_job"]

# User Data Protection
# --------------------

# user_data_fields = [
# 	{
# 		"doctype": "{doctype_1}",
# 		"filter_by": "{filter_by}",
# 		"redact_fields": ["{field_1}", "{field_2}"],
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_2}",
# 		"filter_by": "{filter_by}",
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_3}",
# 		"strict": False,
# 	},
# 	{
# 		"doctype": "{doctype_4}"
# 	}
# ]

# Authentication and authorization
# --------------------------------

# auth_hooks = [
# 	"gsc.auth.validate"
# ]

# Automatically update python controller files with type annotations for this app.
# export_python_type_annotations = True

# default_log_clearing_doctypes = {
# 	"Logging DocType Name": 30  # days to retain logs
# }

# Translation
# ------------
# List of apps whose translatable strings should be excluded from this app's translations.
# ignore_translatable_strings_from = []

