# Python 2.7

def yes_no_to_bool(str, default): # default should be a bool
    str = str.lower()
    if str == 'y' or str == 'yes':
        return True
    elif str == 'n' or str == 'no':
        return False
    else:
        print('Invalid yes or no format. Defaulting to: {}'.format(default))
        return bool(default)

def request_input(caption, default):
    response = raw_input('{} '.format(caption) + ('({}): '.format(default) if default else ''))
    return response if response != '' else default