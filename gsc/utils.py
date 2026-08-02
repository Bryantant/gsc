# Copyright (c) 2026, Hicom System and contributors
# For license information, please see license.txt

from frappe.utils.nestedset import get_descendants_of

# Item Group tree for this business: "Services" is a group node with leaf
# children Shoes/Helm/Topi/Tas today. Resolved dynamically (not hardcoded)
# so a new sub-category added later under Services is picked up with no
# code change.
SERVICE_ITEM_GROUP_ROOT = "Services"


def get_service_item_groups():
	"""Item Groups considered laundry/service items for Laundry Order tracking."""
	return get_descendants_of("Item Group", SERVICE_ITEM_GROUP_ROOT) + [SERVICE_ITEM_GROUP_ROOT]
